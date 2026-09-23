import { describe, expect, it } from 'vitest';
import { checkRequest } from './security.ts';

const PORT = 4747;
const HOST = { host: `127.0.0.1:${PORT}` };

describe('checkRequest', () => {
  it('allows a same-host GET with no Origin', () => {
    expect(checkRequest({ method: 'GET', headers: HOST }, { port: PORT })).toBe(
      null,
    );
  });

  it('accepts a JSON content type with parameters, in any case', () => {
    expect(
      checkRequest(
        {
          method: 'POST',
          headers: {
            ...HOST,
            'content-type': 'Application/JSON; charset=utf-8',
          },
        },
        { port: PORT },
      ),
    ).toBe(null);
  });

  it('rejects a write with no content type', () => {
    expect(
      checkRequest({ method: 'DELETE', headers: HOST }, { port: PORT }),
    ).toMatchObject({ status: 415 });
  });

  it('rejects a missing Host', () => {
    expect(
      checkRequest({ method: 'GET', headers: {} }, { port: PORT }),
    ).toMatchObject({ status: 403 });
  });

  it('allows the dev origin only when configured', () => {
    const req = {
      method: 'POST',
      headers: {
        ...HOST,
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      },
    };
    expect(checkRequest(req, { port: PORT })).toMatchObject({ status: 403 });
    expect(
      checkRequest(req, {
        port: PORT,
        extraOrigins: ['http://127.0.0.1:5173'],
      }),
    ).toBe(null);
  });
});
