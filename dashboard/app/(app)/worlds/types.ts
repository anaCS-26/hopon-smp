export type Mini = { id: string; name: string; title: string; titleTier: string; avatarUrl: string | null };

export type Mod = {
  projectId: string | null; slug: string; title: string; versionId?: string; versionNumber: string; gameVersions: string[] | null;
  filename: string; size?: number; clientSide: string | null; serverSide: string | null; iconUrl?: string | null;
  requires?: string[]; protected: boolean; addedBy: string | null; addedAt: string;
};

export type World = {
  id: string; name: string; description: string; theme: string; host: Mini | null; createdAt: string;
  createdVersion: string; lastPlayedVersion: string | null; lastActiveAt: string | null; playMinutes: number; active: boolean;
  settings: Record<string, string | number | boolean>; mods: Mod[];
  resourcePack: { sha1: string; size: number; files: number; name: string; uploadedBy: string; at: string; url: string } | null;
  can?: Record<string, boolean>;
};

export type SettingSpec = { key: string; label: string; type: 'bool' | 'int' | 'enum' | 'text'; min?: number; max?: number; values?: string[]; createOnly: boolean };
