'use client';
import Link from 'next/link';
import { useAgent } from '@/lib/client/api';
import type { Status } from '../base-camp';

const Ext = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>
);

const TOC: [string, string][] = [
  ['join', 'Joining the server'],
  ['mods', 'What are mods?'],
  ['client-mods', 'Installing mods on your game'],
  ['shaders', 'Shaders (pretty lighting)'],
  ['packs', 'Resource packs'],
  ['safe-sites', 'Safe download sites'],
  ['trouble', 'Something went wrong'],
];

export default function GuidesPage() {
  const { data: s } = useAgent<Status>('status');
  const v = s?.server.mcVersion ?? 'the server version';
  const addr = s?.server.address ?? 'the server address';

  return (
    <>
      <h1 className="page-title">GUIDES</h1>
      <p className="page-sub">Step-by-step help for everything, so nobody has to search sketchy websites. Our server runs <strong>Minecraft Java {v}</strong> with <strong>Fabric</strong>.</p>
      <div className="grid side">
        <nav className="panel toc" aria-label="Guide sections">
          <h2>CHAPTERS</h2>
          <ol className="steps" style={{ fontSize: 15 }}>
            {TOC.map(([id, label]) => <li key={id} style={{ paddingBottom: 8 }}><a href={`#${id}`}>{label}</a></li>)}
          </ol>
        </nav>
        <div className="grid" style={{ gap: 18 }}>
          <section className="panel" id="join">
            <h2>JOINING THE SERVER</h2>
            <ol className="steps">
              <li>Send your exact Minecraft name to the Team Leader, or save it on the <Link href="/crew">Crew</Link> page. Capital letters matter. You can&apos;t join until it&apos;s approved.</li>
              <li>Open Minecraft Java Edition <strong>{v}</strong>. The official launcher works; so does <Ext href="https://prismlauncher.org">Prism Launcher</Ext> (free, open source).</li>
              <li>Multiplayer → <em>Add Server</em> → Server Address: <kbd>{addr}</kbd> → Done → Join.</li>
              <li>The very first time, type in chat: <kbd>/register yourPassword yourPassword</kbd>. Every time after: <kbd>/login yourPassword</kbd>.</li>
              <li>Use a password you don&apos;t use for anything else. This is what stops someone else from joining with your name.</li>
            </ol>
          </section>

          <section className="panel" id="mods">
            <h2>WHAT ARE MODS?</h2>
            <p>Mods are small programs that change the game. There are two kinds:</p>
            <ul className="rows">
              <li><span className="badge go">SERVER ONLY</span><span className="grow">Run on our server. You don&apos;t install anything. Examples: graves, faster ticking, less lag.</span></li>
              <li><span className="badge warn">EVERYONE NEEDS IT</span><span className="grow">Add new blocks, mobs or items. The server <em>and</em> every player must have the same mod, or you can&apos;t join. The world page lists these under &ldquo;What players need&rdquo;.</span></li>
            </ul>
            <p>
              Our rules: mods are only installed from <Ext href="https://modrinth.com/mods">Modrinth</Ext>, only versions made for Fabric {v}, and the server checks every file&apos;s fingerprint. Nobody can upload their own .jar files, because a bad mod could take over the server.
            </p>
            <p className="small muted">Want a mod on a world? If you&apos;re its host, use the Mod Shop tab on that world. If not, ask the host.</p>
          </section>

          <section className="panel" id="client-mods">
            <h2>INSTALLING MODS ON YOUR GAME</h2>
            <p>Only needed when a world&apos;s page says players need a mod. The easiest way is Prism Launcher:</p>
            <ol className="steps">
              <li>Install <Ext href="https://prismlauncher.org/download">Prism Launcher</Ext> from its official site and add your account.</li>
              <li><em>Add Instance</em> → pick version <strong>{v}</strong> → Mod loader: <strong>Fabric</strong> → OK.</li>
              <li>Select the instance → <em>Edit</em> → <em>Mods</em> → <em>Download mods</em>. Search Modrinth from inside Prism and tick the mods the world needs (plus <strong>Fabric API</strong>).</li>
              <li>Press OK, then Launch. Prism downloads the right versions for you.</li>
            </ol>
            <details>
              <summary>Using the official Minecraft launcher instead</summary>
              <ol className="steps" style={{ marginTop: 12 }}>
                <li>Download the installer from <Ext href="https://fabricmc.net/use/installer/">fabricmc.net</Ext> (the official Fabric site) and run it. Pick version {v} → Install.</li>
                <li>Open the launcher once with the new &ldquo;fabric-loader&rdquo; profile, then close it.</li>
                <li>Download each mod&apos;s <kbd>.jar</kbd> for <strong>Fabric {v}</strong> from its Modrinth page.</li>
                <li>Put the .jar files in your <kbd>.minecraft/mods</kbd> folder (Windows: press Win+R, type <kbd>%appdata%\.minecraft</kbd>).</li>
              </ol>
            </details>
          </section>

          <section className="panel" id="shaders">
            <h2>SHADERS (PRETTY LIGHTING)</h2>
            <div className="notice"><p>Shaders run only on <strong>your</strong> computer. The server can&apos;t turn them on for you, and you can use them on any world. They need a decent graphics card; turn them off if your game lags.</p></div>
            <ol className="steps">
              <li>Set up a Fabric {v} instance (see the chapter above).</li>
              <li>Add two mods: <Ext href="https://modrinth.com/mod/sodium">Sodium</Ext> (speed) and <Ext href="https://modrinth.com/mod/iris">Iris</Ext> (shader support). In Prism: Edit → Mods → Download mods → search each.</li>
              <li>Pick a shader pack from <Ext href="https://modrinth.com/shaders">Modrinth shaders</Ext>. Popular, well-known ones: Complementary Reimagined, BSL, Sildur&apos;s. Download the .zip and don&apos;t unzip it.</li>
              <li>Launch the game → Options → Video Settings → <em>Shader Packs</em> → <em>Open Shader Pack Folder</em> → drop the .zip in.</li>
              <li>Back in the game, select the pack → Apply. Press <kbd>K</kbd> any time to turn shaders off and on.</li>
            </ol>
          </section>

          <section className="panel" id="packs">
            <h2>RESOURCE PACKS</h2>
            <p>Resource packs change how blocks and items look. Two ways to use them:</p>
            <ul className="rows">
              <li><span className="badge cool">JUST YOU</span><span className="grow">Options → Resource Packs → Open Pack Folder → drop the .zip in → select it. Only you see it.</span></li>
              <li><span className="badge warn">WHOLE WORLD</span><span className="grow">A world&apos;s host uploads it on the world&apos;s <em>Resource Pack</em> tab. Everyone is offered it when they join.</span></li>
            </ul>
            <p>Find packs on <Ext href="https://modrinth.com/resourcepacks">Modrinth</Ext> or <Ext href="https://www.curseforge.com/minecraft/texture-packs">CurseForge</Ext>, and pick one that lists version {v}.</p>
          </section>

          <section className="panel" id="safe-sites">
            <h2>SAFE DOWNLOAD SITES</h2>
            <table className="plain">
              <thead><tr><th>USE THESE</th><th>FOR</th></tr></thead>
              <tbody>
                <tr><td><Ext href="https://modrinth.com">modrinth.com</Ext></td><td>Mods, shaders, resource packs (our server uses it too)</td></tr>
                <tr><td><Ext href="https://www.curseforge.com/minecraft">curseforge.com</Ext></td><td>Mods and resource packs</td></tr>
                <tr><td><Ext href="https://fabricmc.net">fabricmc.net</Ext></td><td>The Fabric installer</td></tr>
                <tr><td><Ext href="https://prismlauncher.org">prismlauncher.org</Ext></td><td>Prism Launcher</td></tr>
                <tr><td><Ext href="https://www.minecraft.net">minecraft.net</Ext></td><td>The official game and launcher</td></tr>
              </tbody>
            </table>
            <div className="notice danger" style={{ marginTop: 14 }}>
              <p>
                <strong>Avoid:</strong> sites that re-upload mods (names like &ldquo;9minecraft&rdquo; or &ldquo;mc-mods-download&rdquo;), links in YouTube descriptions, anything that gives you an <kbd>.exe</kbd> for a mod, and &ldquo;mod installers&rdquo; that aren&apos;t Prism or Fabric&apos;s own. They are a common way people get viruses or have accounts stolen.
              </p>
            </div>
          </section>

          <section className="panel" id="trouble">
            <h2>SOMETHING WENT WRONG</h2>
            <table className="plain">
              <tbody>
                <tr><td><strong>&ldquo;You are not white-listed&rdquo;</strong></td><td>Your name isn&apos;t approved yet, or the capital letters don&apos;t match. Check the Crew page.</td></tr>
                <tr><td><strong>&ldquo;Incompatible client&rdquo; / &ldquo;Outdated&rdquo;</strong></td><td>Your game version isn&apos;t {v}. Switch versions in the launcher.</td></tr>
                <tr><td><strong>&ldquo;Mod rejection&rdquo; / missing mods</strong></td><td>This world needs a mod on your game. See &ldquo;What players need&rdquo; on the world&apos;s page.</td></tr>
                <tr><td><strong>Forgot your /login password</strong></td><td>Ask the Team Leader to reset your account.</td></tr>
                <tr><td><strong>Can&apos;t connect at all</strong></td><td>Check <Link href="/">Base Camp</Link>: the server might be asleep (press Start) or switching worlds.</td></tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </>
  );
}
