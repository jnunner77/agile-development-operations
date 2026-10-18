// A small HTTP client for the app suites, in the style of supertest:
// `await request(app).post('/api/x').set('X-User', 'Ann').send({ … })`.

import http from 'node:http';

// Headers and body are loosely typed, as supertest's were: tests poke straight into them.
export interface TestResponse {
  readonly status: number;
  /** Lower-case names; set-cookie is a list. */
  readonly headers: Record<string, any>;
  /** Parsed JSON for JSON answers, else an empty object. */
  readonly body: any;
  readonly text: string;
}

/** Each server listens once, on a free port, without keeping the test process alive. */
const listening = new WeakMap<http.Server, Promise<number>>();

function portOf(server: http.Server): Promise<number> {
  const address = server.address();
  if (server.listening && address && typeof address === 'object') return Promise.resolve(address.port);
  let port = listening.get(server);
  if (!port) {
    port = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        const bound = server.address();
        if (bound && typeof bound === 'object') resolve(bound.port);
        else reject(new Error('The test server has no port'));
      });
    });
    listening.set(server, port);
  }
  return port;
}

/** Cookies an agent keeps between requests, as a browser would (name → value). */
type CookieJar = Map<string, string>;

/** Remember the cookies a response sets, and forget the ones it clears. */
function keepCookies(jar: CookieJar, headers: http.IncomingHttpHeaders): void {
  for (const line of headers['set-cookie'] ?? []) {
    const [pair = '', ...attributes] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const expired = attributes.some((a) => /^max-age=\s*(0|-\d+)$/i.test(a)) || attributes.some((a) => /^expires=/i.test(a) && Date.parse(a.slice(8)) <= Date.now());
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

class TestRequest implements PromiseLike<TestResponse> {
  readonly #server: http.Server;
  readonly #method: string;
  readonly #path: string;
  readonly #jar: CookieJar | undefined;
  readonly #headers: Record<string, string> = {};
  #body: string | undefined;

  constructor(server: http.Server, method: string, path: string, jar?: CookieJar) {
    this.#server = server;
    this.#method = method;
    this.#path = path;
    this.#jar = jar;
  }

  set(name: string | Record<string, string>, value?: string): this {
    const pairs = typeof name === 'string' ? [[name, value ?? '']] : Object.entries(name);
    for (const [key, v] of pairs) this.#headers[String(key).toLowerCase()] = String(v);
    return this;
  }

  /** Objects are sent as JSON; text as is (form-encoded unless a Content-Type was set). */
  send(body?: unknown): this {
    if (body === undefined) return this;
    if (typeof body === 'string') {
      this.#headers['content-type'] ??= 'application/x-www-form-urlencoded';
      this.#body = body;
    } else {
      this.#headers['content-type'] ??= 'application/json';
      this.#body = JSON.stringify(body);
    }
    return this;
  }

  async #run(): Promise<TestResponse> {
    const port = await portOf(this.#server);
    const headers: Record<string, string | number> = { ...this.#headers, connection: 'close' };
    if (this.#jar?.size && headers['cookie'] === undefined) headers['cookie'] = [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.#body !== undefined) headers['content-length'] = Buffer.byteLength(this.#body);
    return new Promise<TestResponse>((resolve, reject) => {
      let answered = false;
      const req = http.request({ host: '127.0.0.1', port, method: this.#method, path: this.#path, headers, agent: false }, (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (this.#jar) keepCookies(this.#jar, res.headers);
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = {};
          if (/json/i.test(res.headers['content-type'] ?? '') && text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = {};
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
        res.on('error', reject);
      });
      // A server may answer before reading a large body and close the connection: that's fine.
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      req.end(this.#body);
    });
  }

  then<A = TestResponse, B = never>(onFulfilled?: ((value: TestResponse) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.#run().then(onFulfilled, onRejected);
  }
}

/** Requests to one server; an agent also keeps the cookies it is given, like a signed-in browser. */
class Client {
  readonly #server: http.Server;
  readonly #jar: CookieJar | undefined;

  constructor(server: http.Server, jar?: CookieJar) {
    this.#server = server;
    this.#jar = jar;
  }

  get(path: string) {
    return new TestRequest(this.#server, 'GET', path, this.#jar);
  }
  post(path: string) {
    return new TestRequest(this.#server, 'POST', path, this.#jar);
  }
  put(path: string) {
    return new TestRequest(this.#server, 'PUT', path, this.#jar);
  }
  patch(path: string) {
    return new TestRequest(this.#server, 'PATCH', path, this.#jar);
  }
  delete(path: string) {
    return new TestRequest(this.#server, 'DELETE', path, this.#jar);
  }
}

/** `request(app)` for one-off requests; given an agent, the agent itself (supertest allowed both). */
function request(target: http.Server | Client): Client {
  return target instanceof Client ? target : new Client(target);
}

/** A client that keeps cookies between requests, like a signed-in browser. */
request.agent = (server: http.Server): Client => new Client(server, new Map());

declare namespace request {
  /** What `request.agent(app)` returns. */
  type Agent = Client;
}

export default request;
