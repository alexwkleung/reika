import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts an electron-builder identityName phrase', () => {
    expect(
      redactSecrets('identityName=Developer ID Application: Jane Dev (AB12CD34EF)'),
    ).toBe('identityName=<redacted>');
  });

  it('redacts a quoted signing identity from `security find-identity`', () => {
    expect(redactSecrets('  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Jane Dev (AB12CD34EF)"')).toBe(
      '  1) <redacted> "<redacted>"',
    );
  });

  it('redacts identityHash but leaves a bare git SHA untouched', () => {
    expect(redactSecrets('identityHash=0123456789ABCDEF0123456789ABCDEF01234567')).toBe(
      'identityHash=<redacted>',
    );
    // A bare 40-hex token with no signing context must survive.
    const sha = 'abc1234' + '0'.repeat(33);
    expect(redactSecrets(`HEAD is now at ${sha} fix build`)).toBe(`HEAD is now at ${sha} fix build`);
  });

  it('redacts an Apple app-specific password', () => {
    expect(redactSecrets('using password abcd-efgh-ijkl-mnop for notarytool')).toBe(
      'using password <redacted> for notarytool',
    );
  });

  it('redacts notarization key=value fields', () => {
    expect(redactSecrets('appleId=dev@example.com teamId=AB12CD34EF')).toBe(
      'appleId=<redacted> teamId=<redacted>',
    );
  });

  it('redacts notarization CLI flags in both = and space forms', () => {
    expect(redactSecrets('xcrun notarytool --apple-id dev@example.com --team-id=AB12CD34EF')).toBe(
      'xcrun notarytool --apple-id <redacted> --team-id=<redacted>',
    );
  });

  it('leaves ordinary build output untouched', () => {
    const s = 'Building App.app … done in 12.3s';
    expect(redactSecrets(s)).toBe(s);
  });
});
