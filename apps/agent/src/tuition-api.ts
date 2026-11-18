// REST client for the Tuition API. It is always given the gateway URL, so every call goes through Kong.

export interface Session {
  accessToken: string;
  role: string;
  /** Student number taken from the login response (the same value as the token's studentNo claim). */
  studentNo: string;
}

export interface TermTuition {
  term: string;
  tuitionTotal: number;
  paidAmount: number;
  balance: number;
}

export interface TuitionSummary extends TermTuition {
  studentNo: string;
  scope: 'OVERALL' | 'TERM';
  currency: string;
  terms: TermTuition[];
}

export interface PaymentRequest {
  studentNo: string;
  term: string;
  amount: number;
  transactionId: string;
}

export type PaymentResult = Record<string, unknown> & { status: string; transactionId: string };

/** Error returned by the API or the gateway, with the documented error code when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the agent needs from the API; tests replace it with a fake. */
export interface TuitionApi {
  login(username: string, password: string): Promise<Session>;
  getTuition(session: Session, term?: string): Promise<TuitionSummary>;
  pay(session: Session, payment: PaymentRequest): Promise<PaymentResult>;
}

export class HttpTuitionApi implements TuitionApi {
  constructor(private readonly gatewayUrl: string) {}

  async login(username: string, password: string): Promise<Session> {
    const body = await this.request<{ accessToken: string; role: string; studentNo: string | null }>(
      'POST',
      '/api/v1/auth/login',
      undefined,
      { username, password },
    );
    if (body.role !== 'STUDENT' || !body.studentNo) {
      throw new ApiError(403, 'NOT_A_STUDENT', 'The assistant is for students; please log in with a student account.');
    }
    return { accessToken: body.accessToken, role: body.role, studentNo: body.studentNo };
  }

  getTuition(session: Session, term?: string): Promise<TuitionSummary> {
    // The student number comes from the session (token), never from the conversation.
    const query = term ? `?term=${encodeURIComponent(term)}` : '';
    return this.request('GET', `/api/v1/banking/tuition/${encodeURIComponent(session.studentNo)}${query}`, session);
  }

  pay(session: Session, payment: PaymentRequest): Promise<PaymentResult> {
    return this.request('POST', '/api/v1/banking/payments', session, payment);
  }

  private async request<T>(method: string, path: string, session?: Session, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (session) {
      headers.Authorization = `Bearer ${session.accessToken}`;
    }

    const response = await fetch(`${this.gatewayUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      // API errors carry { error, message }; Kong errors only { message }.
      const code = typeof json.error === 'string' ? json.error : `HTTP_${response.status}`;
      const message = typeof json.message === 'string' ? json.message : response.statusText;
      throw new ApiError(response.status, code, message);
    }
    return json as T;
  }
}
