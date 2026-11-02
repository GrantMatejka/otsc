import { describe, expect, it } from 'vitest';
import {
  serializeCookieParameter,
  serializeHeaderParameter,
  serializePathParameter,
  serializeQueryParameter,
  type ParameterValue,
} from '../../src/serialization/index.js';

const object = { role: 'admin', firstName: 'Alex' };

describe('path parameters', () => {
  it('serializes simple, label and matrix scalars, arrays and objects', () => {
    expect(serializePathParameter({ name: 'id' }, 'a/b? c')).toBe('a%2Fb%3F%20c');
    expect(serializePathParameter({ name: 'id', style: 'simple' }, [3, 4, 5])).toBe('3,4,5');
    expect(serializePathParameter({ name: 'id', explode: true }, object)).toBe('firstName=Alex,role=admin');
    expect(serializePathParameter({ name: 'id', style: 'label' }, [3, 4, 5])).toBe('.3,4,5');
    expect(serializePathParameter({ name: 'id', style: 'label', explode: true }, object)).toBe('.firstName=Alex.role=admin');
    expect(serializePathParameter({ name: 'id', style: 'label', explode: true }, [3, 4])).toBe('.3.4');
    expect(serializePathParameter({ name: 'id', style: 'matrix' }, object)).toBe(';id=firstName,Alex,role,admin');
    expect(serializePathParameter({ name: 'id', style: 'matrix', explode: true }, object)).toBe(';firstName=Alex;role=admin');
    expect(serializePathParameter({ name: 'id', style: 'matrix', explode: true }, [3, 4])).toBe(';id=3;id=4');
    expect(serializePathParameter({ name: 'id', style: 'matrix', explode: true }, '')).toBe(';id=');
  });
});

describe('query parameters', () => {
  it('uses form defaults and preserves repeated keys', () => {
    expect(serializeQueryParameter({ name: 'color' }, ['blue', 'black'])).toBe('color=blue&color=black');
    expect(serializeQueryParameter({ name: 'color', explode: false }, ['blue', 'black'])).toBe('color=blue,black');
    expect(serializeQueryParameter({ name: 'user' }, object)).toBe('firstName=Alex&role=admin');
    expect(serializeQueryParameter({ name: 'user', explode: false }, object)).toBe('user=firstName,Alex,role,admin');
  });
  it('serializes delimited arrays and flat deep objects', () => {
    expect(serializeQueryParameter({ name: 'color', style: 'spaceDelimited' }, ['blue green', 'black'])).toBe('color=blue%20green%20black');
    expect(serializeQueryParameter({ name: 'color', style: 'pipeDelimited' }, ['blue|green', 'black'])).toBe('color=blue%7Cgreen%7Cblack');
    expect(serializeQueryParameter({ name: 'user', style: 'deepObject', explode: true }, { 'a b': 'x&y' })).toBe('user%5Ba%20b%5D=x%26y');
  });
  it('encodes UTF-8, RFC 3986 punctuation and structural delimiters exactly once', () => {
    expect(serializeQueryParameter({ name: 'a &', explode: false }, ['é !*\'()', 'a,b', '%2F'])).toBe('a%20%26=%C3%A9%20%21%2A%27%28%29,a%2Cb,%252F');
    expect(serializeQueryParameter({ name: 'q', allowReserved: true }, ":/?#[]@!$&'()*+,;= %"))
      .toBe("q=:/?%23%5B%5D@!$%26'()*%2B,;%3D%20%25");
    expect(serializeQueryParameter({ name: 'q', allowReserved: true }, { 'a&b': 'a&b' })).toBe('a%26b=a%26b');
    expect(serializeQueryParameter({ name: 'q', allowReserved: true }, '%2F%2f%zz%20+é😀')).toBe('q=%2F%2f%25zz%20%2B%C3%A9%F0%9F%98%80');
    expect(serializeQueryParameter({ name: 'q', allowReserved: true, explode: false }, ['a,b', 'c/d', 'e&f'])).toBe('q=a%2Cb,c/d,e%26f');
    expect(serializeQueryParameter({ name: 'q', allowReserved: true }, ['a,b', 'c#d'])).toBe('q=a,b&q=c%23d');
    const target = new URL(`https://example.test/?${serializeQueryParameter({ name: 'q', allowReserved: true }, 'a#b&c=d+e')}`);
    expect(target.searchParams.get('q')).toBe('a#b&c=d+e');
    expect(target.hash).toBe('');
  });
});

describe('header and cookie parameters', () => {
  it('serializes headers without URI encoding and rejects line breaks', () => {
    expect(serializeHeaderParameter({ name: 'X-Test' }, ['a b', 'c/d'])).toBe('a b,c/d');
    expect(serializeHeaderParameter({ name: 'X-Test', explode: true }, object)).toBe('firstName=Alex,role=admin');
    expect(serializeHeaderParameter({ name: 'X-Test' }, object)).toBe('firstName,Alex,role,admin');
    expect(() => serializeHeaderParameter({ name: 'X-Test' }, 'a\r\nb')).toThrow('CR or LF');
  });
  it('uses RFC6570 form expansion for cookie parameters', () => {
    expect(serializeCookieParameter({ name: 'greeting' }, 'Hello, world!')).toBe('greeting=Hello%2C%20world%21');
    expect(serializeCookieParameter({ name: 'id', style: 'form' }, [1, 2])).toBe('id=1&id=2');
    expect(serializeCookieParameter({ name: 'user', style: 'form' }, object)).toBe('firstName=Alex&role=admin');
    expect(serializeCookieParameter({ name: 'a b' }, { 'x y': 'é' })).toBe('x%20y=%C3%A9');
    expect(serializeCookieParameter({ name: 'id' }, '%2F')).toBe('id=%252F');
  });
  it('honors reserved expansion while escaping cookie-invalid octets and form delimiters', () => {
    expect(serializeCookieParameter({ name: 'id', allowReserved: true }, ":/?#[]@!$'()*+,&;= %2F%zz\\\"é"))
      .toBe("id=:/?#[]@!$'()*+%2C%26%3B%3D%20%2F%25zz%5C%22%C3%A9");
    expect(serializeCookieParameter({ name: 'id', allowReserved: true }, ['a&b', 'c;d']))
      .toBe('id=a%26b&id=c%3Bd');
  });
  it('passes cookie-style values through and separates pairs with semicolon-space', () => {
    expect(serializeCookieParameter({ name: 'session', style: 'cookie' }, 'Hello%2C%20world!')).toBe('session=Hello%2C%20world!');
    expect(serializeCookieParameter({ name: 'id', style: 'cookie' }, [1, 2])).toBe('id=1; id=2');
    expect(serializeCookieParameter({ name: 'user', style: 'cookie' }, object)).toBe('firstName=Alex; role=admin');
    expect(serializeCookieParameter({ name: 'session', style: 'cookie', allowReserved: true }, 'a=b&c/%2F')).toBe('session=a=b&c/%2F');
    for (const style of ['form', 'cookie'] as const) {
      expect(() => serializeCookieParameter({ name: 'id', style, explode: false }, undefined)).toThrow('explode=true');
      expect(() => serializeCookieParameter({ name: 'id', style, explode: false }, 'a')).toThrow('explode=true');
    }
  });
  it('rejects forbidden cookie-style octets and invalid cookie names', () => {
    for (const value of ['a b', 'a,b', 'a;b', 'a"b', 'a\\b', 'é', '\n']) {
      expect(() => serializeCookieParameter({ name: 'id', style: 'cookie', pointer: '#/cookie' }, value)).toThrow('#/cookie: invalid cookie value octet');
    }
    for (const name of ['a b', 'a=b', 'é', 'a;b']) {
      expect(() => serializeCookieParameter({ name, style: 'cookie' }, 'value')).toThrow('invalid cookie name');
    }
    expect(() => serializeCookieParameter({ name: 'id', style: 'cookie' }, { 'bad name': 'x' })).toThrow('invalid cookie name');
    expect(() => serializeCookieParameter({ name: 'id', style: 'cookie' }, ['ok', 'bad value'])).toThrow('invalid cookie value octet');
    expect(() => serializeCookieParameter({ name: 'id', allowReserved: 'yes' as never }, undefined)).toThrow('allowReserved must be a boolean');
  });
});

describe('presence, invalid values and determinism', () => {
  it('distinguishes missing, empty strings, false and zero', () => {
    expect(serializeQueryParameter({ name: 'q' }, undefined)).toBe('');
    expect(serializeCookieParameter({ name: 'q' }, undefined)).toBe('');
    expect(serializeHeaderParameter({ name: 'q' }, undefined)).toBeUndefined();
    expect(() => serializePathParameter({ name: 'q', pointer: '#/parameters/0' }, undefined)).toThrow('#/parameters/0: path parameter is missing');
    expect(serializeQueryParameter({ name: 'q' }, '')).toBe('q=');
    expect(serializeQueryParameter({ name: 'q' }, false)).toBe('q=false');
    expect(serializeQueryParameter({ name: 'q' }, 0)).toBe('q=0');
    expect(serializeHeaderParameter({ name: 'q' }, '')).toBe('');
  });
  it('rejects empty collections, nulls, nested structures and nonfinite numbers with a pointer', () => {
    for (const value of [[], {}, null, [null], { nested: { key: 'value' } }, [undefined], NaN, Infinity, new Date()]) {
      expect(() => serializeQueryParameter({ name: 'q', pointer: '#/p' }, value as ParameterValue)).toThrow('#/p:');
    }
  });
  it('rejects unsupported combinations even when the value is missing', () => {
    expect(() => serializeQueryParameter({ name: 'q', style: 'deepObject' }, undefined)).toThrow('requires explode=true');
    expect(() => serializeQueryParameter({ name: 'q', style: 'deepObject', explode: true }, ['a'])).toThrow('requires a flat object');
    expect(() => serializeQueryParameter({ name: 'q', style: 'pipeDelimited', explode: true }, ['a'])).toThrow('requires explode=false');
    expect(() => serializeQueryParameter({ name: 'q', style: 'spaceDelimited' }, { a: 1 })).toThrow('requires an array');
    expect(() => serializePathParameter({ name: 'q', style: 'form' as never }, 'a')).toThrow('unsupported path style');
    expect(() => serializeCookieParameter({ name: 'q', style: 'simple' as never }, 'a')).toThrow('cookies require form or cookie style');
  });
  it('sorts object keys consistently without changing array order', () => {
    expect(serializeQueryParameter({ name: 'q', explode: false }, { z: 1, a: 2 }))
      .toBe(serializeQueryParameter({ name: 'q', explode: false }, { a: 2, z: 1 }));
    expect(serializeQueryParameter({ name: 'q' }, [2, 1])).toBe('q=2&q=1');
  });
});
