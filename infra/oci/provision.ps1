#Requires -Version 7.2
<#
.SYNOPSIS
    Creates the network and the single Always Free Arm VM for the Minecraft server on Oracle Cloud.

.DESCRIPTION
    Safe to re-run. Every resource is matched by display name inside the configured compartment
    and reused if it already exists. Re-running also refreshes the security list, which is how
    you update the admin IP allowed to SSH in.

    Free-tier guardrails:
      * Refuses any shape larger than 2 OCPU / 12 GB (the Always Free A1 allowance).
      * Refuses to create a second A1 instance in the compartment.
      * Re-checks for an existing instance before every launch attempt, so the
        "Out of host capacity" retry loop can never create two.

    Reads settings from settings.json next to this script (copy settings.example.json).
    Writes resource IDs and the public IP to state.json (git-ignored).

.PARAMETER DryRun
    Only report what exists and what would be created. Makes no changes.

.PARAMETER RetrySeconds
    Seconds to wait between launch attempts when Oracle is out of Arm capacity.

.PARAMETER MaxAttempts
    Give up after this many launch attempts. 0 means keep trying.
#>
[CmdletBinding()]
param(
    [string]$SettingsPath = (Join-Path $PSScriptRoot 'settings.json'),
    [string]$StatePath = (Join-Path $PSScriptRoot 'state.json'),
    [switch]$DryRun,
    [int]$RetrySeconds = 60,
    [int]$MaxAttempts = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The OCI CLI's own Windows ACL check shells out to Windows PowerShell and breaks under pwsh 7.
# Key and config permissions are locked with icacls instead (see README).
$env:OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING = 'True'
$env:SUPPRESS_LABEL_WARNING = 'True'

# ---------------------------------------------------------------- constants
$Shape        = 'VM.Standard.A1.Flex'
$MaxOcpus     = 2
$MaxMemoryGb  = 12
$VcnCidr      = '10.0.0.0/16'
$SubnetCidr   = '10.0.0.0/24'
$Names = @{
    Vcn          = 'mc-vcn'
    Igw          = 'mc-igw'
    SecurityList = 'mc-seclist'
    Subnet       = 'mc-subnet'
    Instance     = 'mc-server'
}
$MinecraftPort = 25565

# ---------------------------------------------------------------- helpers
function Write-Step([string]$Message) {
    Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message)
}

function Resolve-UserPath([string]$Path) {
    if ($Path -like '~*') { $Path = Join-Path $HOME $Path.Substring(1).TrimStart('/', '\') }
    return [IO.Path]::GetFullPath($Path)
}

function Invoke-Oci {
    param([Parameter(ValueFromRemainingArguments)][string[]]$OciArgs)
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $out = & $script:OciCli @OciArgs 2> $errFile
        $code = $LASTEXITCODE
        $err = Get-Content $errFile -Raw
    }
    finally {
        Remove-Item $errFile -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) {
        throw "oci $($OciArgs[0..2] -join ' ') failed (exit $code): $err"
    }
    $text = ($out | Out-String).Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json
}

function Get-Data($Response) {
    if ($null -eq $Response) { return @() }
    return @($Response.data)
}

function Find-Live($Items, [string]$Name) {
    @($Items | Where-Object {
            $null -ne $_ -and $_.'display-name' -eq $Name -and $_.'lifecycle-state' -notin @('TERMINATED', 'TERMINATING')
        }) | Select-Object -First 1
}

function New-JsonFile($Object) {
    $path = [IO.Path]::GetTempFileName()
    ConvertTo-Json -InputObject $Object -Depth 10 | Set-Content -Path $path -Encoding utf8NoBOM
    $script:TempFiles += $path
    return "file://$path"
}

# ---------------------------------------------------------------- settings
if (-not (Test-Path $SettingsPath)) {
    throw "Settings file not found: $SettingsPath. Copy settings.example.json to settings.json and fill it in."
}
$Settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json

$script:OciCli = if ($Settings.ociCli) { Resolve-UserPath $Settings.ociCli } else { 'oci' }
$script:TempFiles = @()
$CompartmentId = $Settings.compartmentId
$SshKeyPath    = Resolve-UserPath $Settings.sshPublicKeyPath
$OciConfig     = Resolve-UserPath $Settings.ociConfigPath

if ($Settings.ocpus -gt $MaxOcpus -or $Settings.memoryGb -gt $MaxMemoryGb) {
    throw "Refusing: $($Settings.ocpus) OCPU / $($Settings.memoryGb) GB exceeds the Always Free A1 allowance ($MaxOcpus OCPU / $MaxMemoryGb GB)."
}
if ($Settings.adminCidr -notmatch '^\d{1,3}(\.\d{1,3}){3}/32$') {
    throw "adminCidr must be a single IPv4 address in /32 form, got '$($Settings.adminCidr)'."
}
if (-not (Test-Path $SshKeyPath)) { throw "SSH public key not found: $SshKeyPath" }
if ((Get-Content $SshKeyPath -Raw) -match 'PRIVATE KEY') { throw "sshPublicKeyPath points at a PRIVATE key. Use the .pub file." }

$TenancyId = (Select-String -Path $OciConfig -Pattern '^\s*tenancy\s*=\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
if (-not $TenancyId) { throw "Could not read the tenancy OCID from $OciConfig" }

$mode = if ($DryRun) { ' (dry run, no changes)' } else { '' }
Write-Step "Provisioning in compartment ...$($CompartmentId.Substring($CompartmentId.Length - 6))$mode"

try {
    # ------------------------------------------------------------ guard: one A1 instance only
    function Get-ExistingInstance {
        $all = Get-Data (Invoke-Oci compute instance list --compartment-id $CompartmentId --all)
        $live = @($all | Where-Object { $null -ne $_ -and $_.shape -eq $Shape -and $_.'lifecycle-state' -notin @('TERMINATED', 'TERMINATING') })
        $ours = $live | Where-Object { $_.'display-name' -eq $Names.Instance } | Select-Object -First 1
        if ($live.Count -gt 1 -or ($live.Count -eq 1 -and -not $ours)) {
            $list = ($live | ForEach-Object { "$($_.'display-name') [$($_.'lifecycle-state')]" }) -join ', '
            throw "Refusing: found A1 instance(s) other than '$($Names.Instance)': $list. Only one A1 VM fits the free allowance."
        }
        return $ours
    }
    $instance = Get-ExistingInstance

    # ------------------------------------------------------------ availability domain + image
    $ad = (Get-Data (Invoke-Oci iam availability-domain list --compartment-id $TenancyId))[0].name
    Write-Step "Availability domain: $ad"

    $images = Get-Data (Invoke-Oci compute image list --compartment-id $CompartmentId `
            --operating-system 'Canonical Ubuntu' --operating-system-version $Settings.ubuntuVersion `
            --shape $Shape --sort-by TIMECREATED --sort-order DESC --all)
    $image = $images | Where-Object { $_.'display-name' -notmatch 'Minimal' } | Select-Object -First 1
    if (-not $image) { throw "No Ubuntu $($Settings.ubuntuVersion) image found for $Shape." }
    Write-Step "Image: $($image.'display-name')"

    # ------------------------------------------------------------ VCN
    $vcn = Find-Live (Get-Data (Invoke-Oci network vcn list --compartment-id $CompartmentId --all)) $Names.Vcn
    if ($vcn) { Write-Step "VCN exists: $($Names.Vcn)" }
    elseif ($DryRun) { Write-Step "Would create VCN $($Names.Vcn) ($VcnCidr)" }
    else {
        Write-Step "Creating VCN $($Names.Vcn) ($VcnCidr)"
        $vcn = (Invoke-Oci network vcn create --compartment-id $CompartmentId --display-name $Names.Vcn `
                --cidr-blocks (New-JsonFile @($VcnCidr)) --dns-label mcvcn --wait-for-state AVAILABLE).data
    }

    # ------------------------------------------------------------ internet gateway + default route
    $igw = $null
    if ($vcn) {
        $igw = Find-Live (Get-Data (Invoke-Oci network internet-gateway list --compartment-id $CompartmentId --vcn-id $vcn.id --all)) $Names.Igw
    }
    if ($igw) { Write-Step "Internet gateway exists: $($Names.Igw)" }
    elseif ($DryRun) { Write-Step "Would create internet gateway $($Names.Igw) and route 0.0.0.0/0 through it" }
    else {
        Write-Step "Creating internet gateway $($Names.Igw)"
        $igw = (Invoke-Oci network internet-gateway create --compartment-id $CompartmentId --vcn-id $vcn.id `
                --display-name $Names.Igw --is-enabled true --wait-for-state AVAILABLE).data
    }
    if (-not $DryRun) {
        $routeRules = @(@{ destination = '0.0.0.0/0'; destinationType = 'CIDR_BLOCK'; networkEntityId = $igw.id })
        Write-Step 'Setting default route to the internet gateway'
        Invoke-Oci network route-table update --rt-id $vcn.'default-route-table-id' `
            --route-rules (New-JsonFile $routeRules) --force --wait-for-state AVAILABLE | Out-Null
    }

    # ------------------------------------------------------------ security list (firewall at the network edge)
    $ingress = @(
        @{
            protocol = '6'; source = $Settings.adminCidr; sourceType = 'CIDR_BLOCK'; isStateless = $false
            description = 'SSH from admin IP only (temporary, until Tailscale)'
            tcpOptions = @{ destinationPortRange = @{ min = 22; max = 22 } }
        },
        @{
            protocol = '6'; source = '0.0.0.0/0'; sourceType = 'CIDR_BLOCK'; isStateless = $false
            description = 'Minecraft Java Edition'
            tcpOptions = @{ destinationPortRange = @{ min = $MinecraftPort; max = $MinecraftPort } }
        },
        @{
            protocol = '1'; source = '0.0.0.0/0'; sourceType = 'CIDR_BLOCK'; isStateless = $false
            description = 'ICMP fragmentation-needed (path MTU discovery)'
            icmpOptions = @{ type = 3; code = 4 }
        },
        @{
            protocol = '1'; source = $VcnCidr; sourceType = 'CIDR_BLOCK'; isStateless = $false
            description = 'ICMP destination-unreachable within the VCN'
            icmpOptions = @{ type = 3 }
        }
    )
    $egress = @(@{ protocol = 'all'; destination = '0.0.0.0/0'; destinationType = 'CIDR_BLOCK'; isStateless = $false })

    $sl = $null
    if ($vcn) {
        $sl = Find-Live (Get-Data (Invoke-Oci network security-list list --compartment-id $CompartmentId --vcn-id $vcn.id --all)) $Names.SecurityList
    }
    if ($DryRun) {
        $verb = if ($sl) { 'update' } else { 'create' }
        Write-Step "Would $verb security list $($Names.SecurityList): TCP 22 from admin IP, TCP $MinecraftPort from anywhere, ICMP 3/4"
    }
    elseif ($sl) {
        Write-Step "Updating security list $($Names.SecurityList)"
        $sl = (Invoke-Oci network security-list update --security-list-id $sl.id `
                --ingress-security-rules (New-JsonFile $ingress) --egress-security-rules (New-JsonFile $egress) `
                --force --wait-for-state AVAILABLE).data
    }
    else {
        Write-Step "Creating security list $($Names.SecurityList)"
        $sl = (Invoke-Oci network security-list create --compartment-id $CompartmentId --vcn-id $vcn.id `
                --display-name $Names.SecurityList `
                --ingress-security-rules (New-JsonFile $ingress) --egress-security-rules (New-JsonFile $egress) `
                --wait-for-state AVAILABLE).data
    }

    # ------------------------------------------------------------ subnet (only our security list attached;
    # the VCN's default list, which allows SSH from anywhere, is deliberately NOT attached)
    $subnet = $null
    if ($vcn) {
        $subnet = Find-Live (Get-Data (Invoke-Oci network subnet list --compartment-id $CompartmentId --vcn-id $vcn.id --all)) $Names.Subnet
    }
    if ($DryRun) {
        if (-not $subnet) { Write-Step "Would create public subnet $($Names.Subnet) ($SubnetCidr)" }
        else { Write-Step "Subnet exists: $($Names.Subnet)" }
    }
    elseif ($subnet) {
        Write-Step "Subnet exists: $($Names.Subnet); making sure only $($Names.SecurityList) is attached"
        Invoke-Oci network subnet update --subnet-id $subnet.id --security-list-ids (New-JsonFile @($sl.id)) `
            --force --wait-for-state AVAILABLE | Out-Null
    }
    else {
        Write-Step "Creating public subnet $($Names.Subnet) ($SubnetCidr)"
        $subnet = (Invoke-Oci network subnet create --compartment-id $CompartmentId --vcn-id $vcn.id `
                --display-name $Names.Subnet --cidr-block $SubnetCidr --dns-label mcsubnet `
                --route-table-id $vcn.'default-route-table-id' --security-list-ids (New-JsonFile @($sl.id)) `
                --wait-for-state AVAILABLE).data
    }

    # ------------------------------------------------------------ instance (retry on capacity)
    if ($instance) {
        Write-Step "Instance exists: $($Names.Instance) [$($instance.'lifecycle-state')]"
    }
    elseif ($DryRun) {
        Write-Step "Would launch $($Names.Instance): $Shape, $($Settings.ocpus) OCPU / $($Settings.memoryGb) GB, $($Settings.bootVolumeGb) GB boot, public IP, retry every $RetrySeconds s on capacity errors"
    }
    else {
        $shapeConfig = @{ ocpus = [double]$Settings.ocpus; memoryInGBs = [double]$Settings.memoryGb }
        $attempt = 0
        while (-not $instance) {
            $attempt++
            # Re-check every time: an earlier attempt may have created the VM even if the wait failed.
            $instance = Get-ExistingInstance
            if ($instance) { Write-Step "Instance appeared: $($Names.Instance)"; break }

            Write-Step "Launch attempt $attempt"
            try {
                $instance = (Invoke-Oci compute instance launch --compartment-id $CompartmentId `
                        --availability-domain $ad --display-name $Names.Instance --hostname-label mcserver `
                        --shape $Shape --shape-config (New-JsonFile $shapeConfig) `
                        --image-id $image.id --boot-volume-size-in-gbs $Settings.bootVolumeGb `
                        --subnet-id $subnet.id --assign-public-ip true `
                        --ssh-authorized-keys-file $SshKeyPath `
                        --wait-for-state RUNNING --max-wait-seconds 900).data
            }
            catch {
                $msg = $_.Exception.Message
                if ($msg -match 'Out of host capacity|OutOfCapacity') {
                    Write-Step "Oracle is out of Arm capacity. Waiting $RetrySeconds s."
                }
                elseif ($msg -match 'TooManyRequests|429') {
                    Write-Step "Rate limited by Oracle. Waiting $($RetrySeconds * 3) s."
                    Start-Sleep -Seconds ($RetrySeconds * 2)
                }
                elseif ($msg -match 'LimitExceeded') {
                    throw "Oracle reports a service limit was exceeded. Stopping; check the free-tier usage in the console. $msg"
                }
                else { throw }

                if ($MaxAttempts -gt 0 -and $attempt -ge $MaxAttempts) {
                    throw "Gave up after $attempt attempts."
                }
                Start-Sleep -Seconds $RetrySeconds
            }
        }
        Write-Step "Instance is $($instance.'lifecycle-state')"
    }

    # ------------------------------------------------------------ report + state
    if ($instance -and -not $DryRun) {
        $vnic = (Get-Data (Invoke-Oci compute instance list-vnics --instance-id $instance.id))[0]
        $state = [ordered]@{
            updated        = (Get-Date).ToString('o')
            instanceId     = $instance.id
            instanceState  = $instance.'lifecycle-state'
            publicIp       = $vnic.'public-ip'
            privateIp      = $vnic.'private-ip'
            vcnId          = $vcn.id
            subnetId       = $subnet.id
            securityListId = $sl.id
            imageName      = $image.'display-name'
        }
        $state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8NoBOM
        Write-Step "Saved IDs and public IP to $StatePath (git-ignored)"
        Write-Step "SSH: ssh -i ~/.ssh/oracle_mc ubuntu@<publicIp from state.json>"
    }
    Write-Step 'Done.'
}
finally {
    foreach ($f in $script:TempFiles) { Remove-Item ($f -replace '^file://', '') -ErrorAction SilentlyContinue }
}
