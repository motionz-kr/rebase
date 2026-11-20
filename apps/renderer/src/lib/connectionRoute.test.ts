import { describe, expect, it } from 'vitest';
import { connectionRouteFromForm, tlsModeForRoute } from './connectionRoute';

describe('connection routing form', () => {
  it('preserves a custom document and document-owned destination', () => {
    expect(connectionRouteFromForm('mysql', 'ssm', { profile: ' default ', region: ' ap-northeast-2 ', instanceId: ' i-0123456789abcdef0 ', documentName: ' Revisit-RdsPortForwarding ', destinationMode: 'document' })).toEqual({
      connectionMode: 'ssm', ssm: { profile: 'default', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0', documentName: 'Revisit-RdsPortForwarding', destinationMode: 'document' },
    });
  });
  it('keeps AWS references separate from DB host and credentials', () => {
    expect(connectionRouteFromForm('mysql', 'ssm', { profile: ' prod ', region: ' ap-northeast-2 ', instanceId: ' i-0123456789abcdef0 ' })).toEqual({
      connectionMode: 'ssm', ssm: { profile: 'prod', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0' },
    });
  });
  it('clears stale tunnel settings when switching to direct or an unsupported DB', () => {
    const ssm = { profile: 'prod', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0' };
    expect(connectionRouteFromForm('postgres', 'direct', ssm)).toEqual({ connectionMode: 'direct', ssm: undefined });
    expect(connectionRouteFromForm('sqlite', 'ssm', ssm)).toEqual({ connectionMode: 'direct', ssm: undefined });
  });
});

it('converts SSH references and clears stale SSH settings on other routes', () => {
  const ssh = { host: ' bastion.example.com ', port: 22, username: ' ec2-user ', identityFile: ' /tmp/key.pem ', knownHostsFile: ' /tmp/known_hosts ' };
  const route = connectionRouteFromForm('mysql', 'ssh', { profile: '', region: '', instanceId: '' }, ssh);
  expect(route).toEqual({ connectionMode: 'ssh', ssm: undefined, ssh: { host: 'bastion.example.com', port: 22, username: 'ec2-user', identityFile: '/tmp/key.pem', knownHostsFile: '/tmp/known_hosts' } });
  expect(connectionRouteFromForm('sqlite', 'ssh', { profile: '', region: '', instanceId: '' }, ssh).ssh).toBeUndefined();
  expect(connectionRouteFromForm('mysql', 'direct', { profile: '', region: '', instanceId: '' }, ssh).ssh).toBeUndefined();
});

describe('GCP Cloud SQL route', () => {
  const ssm = { profile: '', region: '', instanceId: '' };
  it('trims fields and omits default/empty optional values', () => {
    expect(connectionRouteFromForm('mysql', 'gcp_cloudsql', ssm, undefined, { instanceConnectionName: ' p:asia-northeast3:db ', authMode: 'gcloud', credentialsFile: ' /k.json ', privateIp: false, proxyPath: '  ' })).toEqual({
      connectionMode: 'gcp_cloudsql', ssm: undefined, ssh: undefined, gcpCloudSql: { instanceConnectionName: 'p:asia-northeast3:db' },
    });
  });
  it('keeps adc, private IP and proxy path', () => {
    expect(connectionRouteFromForm('postgres', 'gcp_cloudsql', ssm, undefined, { instanceConnectionName: 'p:r:i', authMode: 'adc', credentialsFile: '/k.json', privateIp: true, proxyPath: ' /opt/cloud-sql-proxy ' }).gcpCloudSql)
      .toEqual({ instanceConnectionName: 'p:r:i', authMode: 'adc', privateIp: true, proxyPath: '/opt/cloud-sql-proxy' });
  });
  it('includes credentialsFile only for credentials_file', () => {
    expect(connectionRouteFromForm('sqlserver', 'gcp_cloudsql', ssm, undefined, { instanceConnectionName: 'p:r:i', authMode: 'credentials_file', credentialsFile: ' /Users/me/sa.json ' }).gcpCloudSql)
      .toEqual({ instanceConnectionName: 'p:r:i', authMode: 'credentials_file', credentialsFile: '/Users/me/sa.json' });
  });
  it('falls back to direct for unsupported drivers and clears gcp on other modes', () => {
    const gcp = { instanceConnectionName: 'p:r:i' };
    expect(connectionRouteFromForm('sqlite', 'gcp_cloudsql', ssm, undefined, gcp)).toEqual({ connectionMode: 'direct', ssm: undefined, ssh: undefined, gcpCloudSql: undefined });
    expect(connectionRouteFromForm('mysql', 'direct', ssm, undefined, gcp).gcpCloudSql).toBeUndefined();
    expect(connectionRouteFromForm('mysql', 'ssm', { profile: '', region: 'r', instanceId: 'i' }, undefined, gcp).gcpCloudSql).toBeUndefined();
  });
});

describe('route switching over an existing profile', () => {
  const ssm = { profile: 'p', region: 'r', instanceId: 'i-1' };
  const ssh = { host: 'h', port: 22, username: 'u', identityFile: '/k' };
  const gcp = { instanceConnectionName: 'p:r:i', authMode: 'credentials_file' as const, credentialsFile: '/k.json' };
  const saved = { name: 'x', connectionMode: 'gcp_cloudsql', gcpCloudSql: gcp, ssm, ssh };
  it('drops stale gcpCloudSql when merged for direct, ssm and ssh', () => {
    for (const mode of ['direct', 'ssm', 'ssh'] as const) {
      const merged = { ...saved, ...connectionRouteFromForm('mysql', mode, ssm, ssh, gcp) };
      expect(merged.gcpCloudSql).toBeUndefined();
    }
  });
  it('drops stale ssm/ssh when switching to gcp_cloudsql', () => {
    const merged = { ...saved, ...connectionRouteFromForm('mysql', 'gcp_cloudsql', ssm, ssh, gcp) };
    expect(merged.ssm).toBeUndefined();
    expect(merged.ssh).toBeUndefined();
    expect(merged.gcpCloudSql).toEqual(gcp);
  });
});

describe('tlsModeForRoute', () => {
  it('normalizes require to none only for Cloud SQL', () => {
    expect(tlsModeForRoute('gcp_cloudsql', 'require')).toBe('none');
    expect(tlsModeForRoute('gcp_cloudsql', 'prefer')).toBe('prefer');
    expect(tlsModeForRoute('direct', 'require')).toBe('require');
  });
});
