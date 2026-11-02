export function makePredicate<Value extends number | string>(input: string | ((value: Value) => boolean) | undefined, variable: 'status' | 'mediaType', fallback: (value: Value) => boolean): (value: Value) => boolean {
  if (input === undefined) return fallback;
  if (typeof input === 'function') return input;
  const tokenPattern = /\s*(===|!==|>=|<=|==|!=|&&|\|\||>|<|!|\(|\)|\[|\]|\.|,|%|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)/gy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (!input.slice(offset).trim()) break;
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(input);
    if (!match) throw new Error(`OTSC compatibility: unsupported predicate expression near ${JSON.stringify(input.slice(offset))}`);
    tokens.push(match[1]);
    offset = tokenPattern.lastIndex;
  }
  let index = 0;
  type Expression = (value: Value) => unknown;
  function primary(): Expression {
    const token = tokens[index++];
    if (token === '!') { const operand = atom(); return value => !operand(value); }
    if (token === '(') {
      const expression = disjunction();
      if (tokens[index++] !== ')') throw new Error('OTSC compatibility: invalid predicate parentheses');
      return expression;
    }
    if (token === '[') {
      const entries: Expression[] = [];
      while (tokens[index] !== ']') {
        if (index >= tokens.length) throw new Error('OTSC compatibility: invalid predicate array');
        entries.push(disjunction());
        if (tokens[index] !== ',') break;
        index++;
      }
      if (tokens[index++] !== ']') throw new Error('OTSC compatibility: invalid predicate array');
      return value => entries.map(entry => entry(value));
    }
    if (token === variable) return value => value;
    if (token === 'true' || token === 'false') return () => token === 'true';
    if (token && /^-?\d/.test(token)) { const number = Number(token); return () => number; }
    if (token?.startsWith('"')) { const value = JSON.parse(token); return () => value; }
    if (token?.startsWith("'")) {
      const value = token.slice(1, -1).replace(/\\(['\\nrt])/g, (_match, escaped: string) => ({ n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped)); return () => value;
    }
    throw new Error(`OTSC compatibility: invalid predicate token ${JSON.stringify(token)}`);
  }
  function atom(): Expression {
    let result = primary();
    while (tokens[index] === '.') {
      index++;
      const method = tokens[index++];
      if (!['includes', 'startsWith', 'endsWith'].includes(method) || tokens[index++] !== '(') throw new Error(`OTSC compatibility: unsupported predicate method ${method}`);
      const argument = disjunction();
      if (tokens[index++] !== ')') throw new Error('OTSC compatibility: invalid predicate method arguments');
      const receiver = result;
      result = value => {
        const target = receiver(value);
        const arg = argument(value);
        if (method === 'includes' && Array.isArray(target)) return target.includes(arg);
        if (typeof target !== 'string' || typeof arg !== 'string') return false;
        if (method === 'includes') return target.includes(arg);
        if (method === 'startsWith') return target.startsWith(arg);
        return target.endsWith(arg);
      };
    }
    return result;
  }
  function arithmetic(): Expression {
    let result = atom();
    while (tokens[index] === '%') {
      index++;
      const left = result, right = atom();
      result = value => Number(left(value)) % Number(right(value));
    }
    return result;
  }
  function comparison(): Expression {
    const left = arithmetic();
    const operator = tokens[index];
    if (!['===', '!==', '==', '!=', '>', '<', '>=', '<='].includes(operator)) return left;
    index++;
    const right = arithmetic();
    return value => {
      const leftValue = left(value) as string | number;
      const rightValue = right(value) as string | number;
      if (operator === '===' || operator === '!==') return operator === '===' ? leftValue === rightValue : leftValue !== rightValue;
      if (operator === '==' || operator === '!=') {
        const equal = typeof leftValue === typeof rightValue ? leftValue === rightValue : Number(leftValue) === Number(rightValue);
        return operator === '==' ? equal : !equal;
      }
      if (operator === '>') return leftValue > rightValue;
      if (operator === '<') return leftValue < rightValue;
      if (operator === '>=') return leftValue >= rightValue;
      return leftValue <= rightValue;
    };
  }
  function conjunction(): Expression {
    let result = comparison();
    while (tokens[index] === '&&') { index++; const left = result; const right = comparison(); result = value => Boolean(left(value)) && Boolean(right(value)); }
    return result;
  }
  function disjunction(): Expression {
    let result = conjunction();
    while (tokens[index] === '||') { index++; const left = result; const right = conjunction(); result = value => Boolean(left(value)) || Boolean(right(value)); }
    return result;
  }
  const expression = disjunction();
  if (index !== tokens.length) throw new Error(`OTSC compatibility: unsupported predicate token ${JSON.stringify(tokens[index])}`);
  return value => Boolean(expression(value));
}
