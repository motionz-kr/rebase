export interface SSMConfig {
  profile: string;
  region: string;
  instanceId: string;
  documentName?: string;
  destinationMode?: 'remote-host' | 'document';
}

export function connectionRouteFromForm(driver: string, mode: 'direct' | 'ssm', settings: SSMConfig): {
  connectionMode: 'direct' | 'ssm'; ssm?: SSMConfig;
} {
  if (mode !== 'ssm' || (driver !== 'mysql' && driver !== 'postgres')) {
    return { connectionMode: 'direct', ssm: undefined };
  }
  return {
    connectionMode: 'ssm',
    ssm: {
      profile: settings.profile.trim(), region: settings.region.trim(), instanceId: settings.instanceId.trim(),
      ...(settings.documentName?.trim() ? { documentName: settings.documentName.trim() } : {}),
      ...(settings.destinationMode ? { destinationMode: settings.destinationMode } : {}),
    },
  };
}
