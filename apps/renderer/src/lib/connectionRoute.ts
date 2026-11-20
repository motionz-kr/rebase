export type ConnectionMode = 'direct' | 'ssm' | 'ssh' | 'gcp_cloudsql';
export interface GCPCloudSQLConfig {
  instanceConnectionName: string;
  authMode?: 'gcloud' | 'adc' | 'credentials_file';
  credentialsFile?: string;
  privateIp?: boolean;
  proxyPath?: string;
}
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

export function connectionRouteFromForm(driver: string, mode: ConnectionMode, settings: SSMConfig, ssh?: SSHConfig, gcp?: GCPCloudSQLConfig): {
  connectionMode: ConnectionMode; ssm?: SSMConfig; ssh?: SSHConfig; gcpCloudSql?: GCPCloudSQLConfig;
} {
  if (mode === 'gcp_cloudsql' && gcp && (driver === 'mysql' || driver === 'postgres' || driver === 'sqlserver')) {
    const authMode = gcp.authMode && gcp.authMode !== 'gcloud' ? gcp.authMode : undefined;
    const credentialsFile = authMode === 'credentials_file' ? gcp.credentialsFile?.trim() : '';
    return { connectionMode: 'gcp_cloudsql', ssm: undefined, ssh: undefined, gcpCloudSql: {
      instanceConnectionName: gcp.instanceConnectionName.trim(),
      ...(authMode ? { authMode } : {}),
      ...(credentialsFile ? { credentialsFile } : {}),
      ...(gcp.privateIp ? { privateIp: true } : {}),
      ...(gcp.proxyPath?.trim() ? { proxyPath: gcp.proxyPath.trim() } : {}),
    } };
  }
  if (mode === 'ssh' && (driver === 'mysql' || driver === 'postgres')) {
    return { connectionMode: 'ssh', ssm: undefined, gcpCloudSql: undefined, ssh: ssh && {
      host: ssh.host.trim(), port: ssh.port, username: ssh.username.trim(), identityFile: ssh.identityFile.trim(),
      ...(ssh.knownHostsFile?.trim() ? { knownHostsFile: ssh.knownHostsFile.trim() } : {}),
    } };
  }
  if (mode !== 'ssm' || (driver !== 'mysql' && driver !== 'postgres')) {
    return { connectionMode: 'direct', ssm: undefined, ssh: undefined, gcpCloudSql: undefined };
  }
  return {
    connectionMode: 'ssm', ssh: undefined, gcpCloudSql: undefined,
    ssm: {
      profile: settings.profile.trim(), region: settings.region.trim(), instanceId: settings.instanceId.trim(),
      ...(settings.documentName?.trim() ? { documentName: settings.documentName.trim() } : {}),
      ...(settings.destinationMode ? { destinationMode: settings.destinationMode } : {}),
    },
  };
}

export type TlsMode = 'none' | 'prefer' | 'require';
// cloud-sql-proxy already encrypts the hop; the engine only accepts none/prefer in Cloud SQL mode.
export function tlsModeForRoute(mode: ConnectionMode, tls: TlsMode): TlsMode {
  return mode === 'gcp_cloudsql' && tls === 'require' ? 'none' : tls;
}
