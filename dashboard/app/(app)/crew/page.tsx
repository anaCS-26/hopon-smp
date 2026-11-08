'use client';
import { useState } from 'react';
import { api, useAgent, timeAgo } from '@/lib/client/api';
import { Avatar, PixelFace } from '@/components/pixel';
import { TitleTag, useAction, Modal, CopyButton } from '@/components/ui';
import { useMe } from '@/components/me';

type User = {
  id: string; name: string; avatarUrl: string | null; role: 'owner' | 'admin' | 'member'; title: string; titleTier: string;
  mcName: string | null; mcStatus: 'none' | 'pending' | 'whitelisted'; status: 'active' | 'disabled'; createdAt: string; lastSeenAt: string; offlineUuid?: string;
};
type Invite = { id: string; role: string; title: string; titleTier: string; note: string; createdAt: string; expiresAt: string; usedBy: { name: string } | null; usedAt: string | null; expired: boolean };

const FUN_TITLES = [
  'Creeper Whisperer', 'Professional Cave Explorer', 'Chief Dirt Hut Architect', 'Redstone Wizard', 'Lava Bucket Enthusiast',
  'Diamond Hoarder', 'Village Mayor', 'Bed Explosion Survivor', 'Llama Diplomat', 'Nether Tourist', 'Certified Farmer', 'Frog Ambassador',
];
const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const ROLE_BADGE: Record<string, string> = { owner: 'warn', admin: 'epic', member: '' };

export default function CrewPage() {
  const me = useMe();
  const { data, reload } = useAgent<{ users: User[] }>('users', 15000);
  const [editing, setEditing] = useState<User | null>(null);
  const { busy, run } = useAction();
  const self = data?.users.find((u) => u.id === me.user.id);
  const order = { owner: 0, admin: 1, member: 2 };
  const users = [...(data?.users || [])].sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));

  return (
    <>
      <h1 className="page-title">THE CREW</h1>
      <p className="page-sub">Everyone with dashboard access. To play, each person also needs their Minecraft name whitelisted. The Team Leader or an admin approves it.</p>

      {self && <McNameCard self={self} reload={reload} />}

      <div className="grid cards" style={{ marginTop: 18 }}>
        {users.map((u) => (
          <section key={u.id} className="panel" style={{ opacity: u.status === 'disabled' ? 0.55 : 1 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <span style={{ boxShadow: '0 0 0 4px var(--edge), 6px 6px 0 4px #0006', lineHeight: 0 }}><PixelFace name={u.mcName || u.name} size={56} /></span>
              <div className="grow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={u.name} url={u.avatarUrl} size={20} />
                  <strong style={{ fontSize: 18 }} className="ellipsis">{u.name}</strong>
                </div>
                <div style={{ marginTop: 6 }}><TitleTag title={u.title} tier={u.titleTier} /></div>
              </div>
            </div>
            <div className="small" style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`badge ${ROLE_BADGE[u.role]}`}>{u.role === 'owner' ? 'TEAM LEADER' : u.role.toUpperCase()}</span>
              {u.status === 'disabled' && <span className="badge danger">ACCESS OFF</span>}
              {u.mcName ? (
                <>
                  <span className="mono" style={{ color: 'var(--gold)' }}>{u.mcName}</span>
                  {u.mcStatus === 'whitelisted' ? <span className="badge go">WHITELISTED</span> : <span className="badge warn">WAITING</span>}
                </>
              ) : (
                <span className="muted">no Minecraft name yet</span>
              )}
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>Joined {timeAgo(u.createdAt)} · seen {timeAgo(u.lastSeenAt)}</p>
            {(me.can.whitelist || me.can.manageUsers) && (
              <div className="btn-row" style={{ marginTop: 12 }}>
                {me.can.whitelist && u.mcName && u.mcStatus !== 'whitelisted' && (
                  <button className="btn go sm" disabled={!!busy} onClick={() => run('wl', async () => { await api('POST', `users/${u.id}/whitelist`); reload(); }, `${u.mcName} can now join`)}>
                    APPROVE {u.mcName}
                  </button>
                )}
                {me.can.manageUsers && <button className="btn sm" onClick={() => setEditing(u)}>EDIT</button>}
              </div>
            )}
          </section>
        ))}
      </div>

      {me.can.manageUsers && <Invites />}
      {editing && <EditUser u={editing} onClose={() => setEditing(null)} reload={reload} isSelf={editing.id === me.user.id} />}
    </>
  );
}

function McNameCard({ self, reload }: { self: User; reload: () => void }) {
  const [name, setName] = useState(self.mcName || '');
  const { busy, run } = useAction();
  const valid = /^[A-Za-z0-9_]{3,16}$/.test(name);
  return (
    <section className="panel raised">
      <div className="grid two" style={{ alignItems: 'center' }}>
        <div>
          <h2>YOUR MINECRAFT NAME</h2>
          <p className="small" style={{ marginTop: 0 }}>
            Type it <strong>exactly</strong> as in your launcher. Capital letters matter on our server: <span className="mono">Steve123</span> and <span className="mono">steve123</span> are different players.
          </p>
          {self.offlineUuid && <p className="small muted">Your player ID on this server: <span className="mono">{self.offlineUuid}</span></p>}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input className="input mono" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} placeholder="YourName" aria-label="Minecraft name" />
          <button className="btn go" disabled={!valid || name === self.mcName || !!busy}
            onClick={() => run('mc', async () => { await api('POST', 'users/me/mc-name', { mcName: name }); reload(); }, 'Saved. The Team Leader will approve it.')}>
            SAVE
          </button>
        </div>
      </div>
    </section>
  );
}

function EditUser({ u, onClose, reload, isSelf }: { u: User; onClose: () => void; reload: () => void; isSelf: boolean }) {
  const [title, setTitle] = useState(u.title);
  const [tier, setTier] = useState(u.titleTier);
  const [role, setRole] = useState(u.role);
  const { busy, run } = useAction();
  const save = () =>
    run('save', async () => {
      const patch: any = { title, titleTier: tier };
      if (u.role !== 'owner' && role !== u.role) patch.role = role;
      await api('PATCH', `users/${u.id}`, patch);
      reload();
      onClose();
    }, 'Updated');

  return (
    <Modal title={`EDIT ${u.name.toUpperCase()}`} onClose={onClose}>
      <p style={{ marginTop: 0 }}>Preview: <TitleTag title={title} tier={tier} /></p>
      <label className="field"><span>Fun title</span><input className="input" maxLength={32} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="btn-row" style={{ marginBottom: 14 }}>
        {FUN_TITLES.map((t) => <button key={t} className="btn ghost sm" onClick={() => setTitle(t)}>{t}</button>)}
      </div>
      <label className="field">
        <span>Rarity colour</span>
        <select className="input" value={tier} onChange={(e) => setTier(e.target.value)}>{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
      </label>
      {u.role !== 'owner' && (
        <label className="field">
          <span>Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
            <option value="member">Member: plays, makes and hosts their own worlds</option>
            <option value="admin">Admin: also helps run any world, approves names, sees the logbook</option>
          </select>
        </label>
      )}
      <div className="btn-row">
        <button className="btn go" disabled={!title.trim() || !!busy} onClick={save}>SAVE</button>
        {!isSelf && (
          <button className={`btn ${u.status === 'active' ? 'danger' : 'warn'} sm`} disabled={!!busy}
            onClick={() => run('st', async () => { await api('PATCH', `users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }); reload(); onClose(); }, u.status === 'active' ? 'Access turned off' : 'Access turned back on')}>
            {u.status === 'active' ? 'TURN OFF ACCESS' : 'TURN ACCESS BACK ON'}
          </button>
        )}
        <button className="btn ghost sm" disabled={!!busy} onClick={() => run('lo', async () => { await api('POST', `users/${u.id}/logout-all`); }, 'Logged out on all devices')}>LOG OUT EVERYWHERE</button>
      </div>
    </Modal>
  );
}

function Invites() {
  const { data, reload } = useAgent<{ invites: Invite[] }>('invites');
  const [title, setTitle] = useState('Crew Member');
  const [tier, setTier] = useState('common');
  const [role, setRole] = useState('member');
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <h2>INVITES <span className="hint">only you can see this</span></h2>
      <div className="grid two">
        <div>
          <label className="field"><span>Who is it for? (a note for you)</span><input className="input" maxLength={60} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sam from school" /></label>
          <label className="field"><span>Their starting title</span><input className="input" maxLength={32} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="grid two">
            <label className="field"><span>Rarity</span><select className="input" value={tier} onChange={(e) => setTier(e.target.value)}>{TIERS.map((t) => <option key={t}>{t}</option>)}</select></label>
            <label className="field"><span>Role</span><select className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">member</option><option value="admin">admin</option></select></label>
          </div>
          <button className="btn go" disabled={!title.trim() || !!busy}
            onClick={() => run('inv', async () => { const r = await api('POST', 'invites', { title, titleTier: tier, role, note }); setLink(`${window.location.origin}/invite/${r.code}`); reload(); }, 'Invite created')}>
            MAKE INVITE LINK
          </button>
          {link && (
            <div className="notice go" style={{ marginTop: 14, display: 'block' }}>
              <p className="small">Send this link to them privately (it works once and expires in 7 days). It won&apos;t be shown again.</p>
              <div className="address" style={{ width: '100%' }}>
                <code style={{ fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{link}</code>
                <CopyButton text={link} />
              </div>
            </div>
          )}
        </div>
        <div>
          <ul className="rows">
            {data?.invites.slice().reverse().map((i) => (
              <li key={i.id}>
                <span className="grow small">
                  <TitleTag title={i.title} tier={i.titleTier} /> {i.note && <strong>{i.note}</strong>}
                  <br />
                  <span className="muted">
                    {i.usedBy ? `used by ${i.usedBy.name} ${timeAgo(i.usedAt)}` : i.expired ? 'expired' : `unused · made ${timeAgo(i.createdAt)}`}
                  </span>
                </span>
                {!i.usedBy && <button className="btn ghost sm" disabled={!!busy} onClick={() => run('rv', async () => { await api('DELETE', `invites/${i.id}`); reload(); }, 'Invite cancelled')}>CANCEL</button>}
              </li>
            ))}
          </ul>
          {data?.invites.length === 0 && <div className="empty">No invites yet.</div>}
        </div>
      </div>
    </section>
  );
}
