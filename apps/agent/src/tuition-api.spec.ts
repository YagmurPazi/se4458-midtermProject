import { ApiError, HttpTuitionApi, Session } from './tuition-api';

// The REST client is tested with a mocked fetch: no gateway or API is needed.

const GATEWAY = 'http://gateway.test';
const session: Session = { accessToken: 'jwt-token', role: 'STUDENT', studentNo: '20230001' };

function respond(status: number, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    text: async () => JSON.stringify(body),
  });
}

describe('HttpTuitionApi', () => {
  const api = new HttpTuitionApi(GATEWAY);
  afterEach(() => jest.restoreAllMocks());

  it('logs in through the gateway and keeps the student number from the response', async () => {
    const fetchMock = respond(200, { accessToken: 'jwt-token', role: 'STUDENT', studentNo: '20230001' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    await expect(api.login('20230001', 'secret')).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith(`${GATEWAY}/api/v1/auth/login`, expect.objectContaining({ method: 'POST' }));
  });

  it('refuses a non-student login', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(respond(200, { accessToken: 't', role: 'BANK', studentNo: null }));

    await expect(api.login('bank', 'secret')).rejects.toMatchObject({
      code: 'NOT_A_STUDENT',
      role: 'BANK',
    });
  });

  it("queries the session's own student number with the bearer token", async () => {
    const fetchMock = respond(200, { balance: 1500 });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    await api.getTuition(session, '2026-FALL');

    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY}/api/v1/banking/tuition/20230001?term=2026-FALL`,
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }) }),
    );
  });

  it('maps an API error body to ApiError with its code', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      respond(422, { statusCode: 422, error: 'AMOUNT_EXCEEDS_BALANCE', message: 'too much' }),
    );

    const payment = { studentNo: '20230001', term: '2026-FALL', amount: 9999, transactionId: 'tx-123456' };
    await expect(api.pay(session, payment)).rejects.toEqual(new ApiError(422, 'AMOUNT_EXCEEDS_BALANCE', 'too much'));
  });

  it('maps a gateway error (Kong body without a code) to HTTP_<status>', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(respond(401, { message: 'Unauthorized' }));

    await expect(api.getTuition(session)).rejects.toMatchObject({ status: 401, code: 'HTTP_401', message: 'Unauthorized' });
  });
});
