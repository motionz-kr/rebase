import { describe, expect, it } from 'vitest';
import { connectionRouteFromForm } from './connectionRoute';

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
