export function requiredOperatorInput(name, environment = process.env) {
  const value = environment[name];
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error(`Required operator input is unavailable: ${name}`);
  return value;
}
