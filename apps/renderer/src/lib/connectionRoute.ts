export type ConnectionMode = 'direct' | 'ssm' | 'ssh';
export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  identityFile: string;
  knownHostsFile?: string;
}
export interface SSMConfig {
  profile: string;
  region: string;
  instanceId: string;
  documentName?: string;
  destinationMode?: 'remote-host' | 'document';
}

export function connectionRouteFromForm(driver: string, mode: ConnectionMode, settings: SSMConfig, ssh?: SSHConfig): {
  connectionMode: ConnectionMode; ssm?: SSMConfig; ssh?: SSHConfig;
} {
  if (mode === 'ssh' && (driver === 'mysql' || driver === 'postgres')) {
    return { connectionMode: 'ssh', ssm: undefined, ssh: ssh && {
      host: ssh.host.trim(), port: ssh.port, username: ssh.username.trim(), identityFile: ssh.identityFile.trim(),
      ...(ssh.knownHostsFile?.trim() ? { knownHostsFile: ssh.knownHostsFile.trim() } : {}),
    } };
  }
  if (mode !== 'ssm' || (driver !== 'mysql' && driver !== 'postgres')) {
    return { connectionMode: 'direct', ssm: undefined, ssh: undefined };
  }
  return {
    connectionMode: 'ssm', ssh: undefined,
    ssm: {
      profile: settings.profile.trim(), region: settings.region.trim(), instanceId: settings.instanceId.trim(),
      ...(settings.documentName?.trim() ? { documentName: settings.documentName.trim() } : {}),
      ...(settings.destinationMode ? { destinationMode: settings.destinationMode } : {}),
    },
  };
}
