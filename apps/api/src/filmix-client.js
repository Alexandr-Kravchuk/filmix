import iconv from 'iconv-lite';

function getSetCookies(headers) {
  if (headers && typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const fallback = headers.get('set-cookie');
  return fallback ? [fallback] : [];
}

function parseCookieName(cookieLine) {
  const first = String(cookieLine || '').split(';')[0];
  const index = first.indexOf('=');
  if (index === -1) {
    return null;
  }
  return {
    name: first.slice(0, index).trim(),
    value: first.slice(index + 1).trim()
  };
}
function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const index = chunk.indexOf('=');
      if (index === -1) {
        return null;
      }
      const name = chunk.slice(0, index).trim();
      const value = chunk.slice(index + 1).trim();
      if (!name || !value) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean);
}

function parsePostId(pageUrl) {
  const match = String(pageUrl).match(/\/(\d+)-[^/]+\.html$/i);
  if (!match) {
    throw new Error('Unable to parse post_id from FILMIX_PAGE_URL');
  }
  return match[1];
}

export class FilmixClient {
  constructor(config) {
    this.pageUrl = config.pageUrl;
    this.login = config.login;
    this.password = config.password;
    this.userAgent = config.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    this.cookieJar = new Map();
    this.authenticated = false;
    this.postId = parsePostId(this.pageUrl);
    this.origin = new URL(this.pageUrl).origin;
    this.applyCookieHeader(config.cookie || '');
  }
  applyCookieHeader(cookieHeader) {
    const parsedCookies = parseCookieHeader(cookieHeader);
    for (const cookie of parsedCookies) {
      this.cookieJar.set(cookie.name, cookie.value);
    }
  }
  hasValidAuthCookies() {
    const userId = String(this.cookieJar.get('dle_user_id') || '').toLowerCase();
    const password = String(this.cookieJar.get('dle_password') || '').toLowerCase();
    return Boolean(userId && password && userId !== 'deleted' && password !== 'deleted');
  }
  getCookieHeader() {
    const entries = Array.from(this.cookieJar.entries()).filter((entry) => {
      const value = String(entry[1] || '').toLowerCase();
      return Boolean(value && value !== 'deleted');
    });
    if (!entries.length) {
      return '';
    }
    return entries
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  updateCookieJar(headers) {
    const setCookies = getSetCookies(headers);
    for (const cookieLine of setCookies) {
      const parsed = parseCookieName(cookieLine);
      if (!parsed) {
        continue;
      }
      this.cookieJar.set(parsed.name, parsed.value);
    }
  }

  async request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('User-Agent', this.userAgent);
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }
    const response = await fetch(url, {
      ...options,
      headers
    });
    this.updateCookieJar(response.headers);
    return response;
  }

  async readResponseText(response, encoding = 'utf8') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (encoding === 'windows-1251') {
      return iconv.decode(buffer, 'win1251');
    }
    return buffer.toString('utf8');
  }

  async submitLogin() {
    const body = new URLSearchParams({
      login_name: this.login,
      login_password: this.password,
      login: 'submit',
      login_not_save: 'yes'
    });
    const response = await this.request(`${this.origin}/engine/ajax/user_auth.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: this.pageUrl,
        Origin: this.origin,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*'
      },
      body: body.toString()
    });
    const text = await this.readResponseText(response);
    if (!response.ok) {
      throw new Error(`Filmix login failed: HTTP ${response.status}`);
    }
    const trimmed = text.trim();
    const hasAuthCookies = this.hasValidAuthCookies();
    const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(trimmed);
    if (trimmed && trimmed !== 'AUTHORIZED' && trimmed !== 'OK' && !looksLikeHtml && !hasAuthCookies) {
      throw new Error(`Filmix login failed: ${trimmed}`);
    }
  }

  async ensureAuthenticated(force = false) {
    if (this.authenticated && !force) {
      return;
    }
    await this.request(this.pageUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    const hasAuthCookies = this.hasValidAuthCookies();
    if (force || !hasAuthCookies) {
      if (!this.login || !this.password) {
        throw new Error('Filmix auth cookies are missing and FILMIX_LOGIN/FILMIX_PASSWORD are not configured');
      }
      await this.submitLogin();
    }
    if (!this.hasValidAuthCookies()) {
      throw new Error('Filmix authentication cookies are not available');
    }
    this.authenticated = true;
  }

  async getPlayerData() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureAuthenticated(attempt > 0);
      const body = new URLSearchParams({
        post_id: this.postId,
        showfull: 'true'
      });
      const response = await this.request(`${this.origin}/api/movies/player-data?t=${Date.now()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: this.pageUrl,
          Origin: this.origin,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01'
        },
        body: body.toString()
      });
      const text = await this.readResponseText(response, 'windows-1251');
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        this.authenticated = false;
        if (attempt === 1) {
          throw new Error(`Invalid player-data payload: ${error.message}`);
        }
        continue;
      }
      if (data && data.message) {
        return data;
      }
      this.authenticated = false;
    }
    throw new Error('Filmix player-data response does not contain message');
  }
}
