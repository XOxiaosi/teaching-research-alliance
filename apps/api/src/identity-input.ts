const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAINLAND_MOBILE = /^1[3-9][0-9]{9}$/;

const normalizedText = (
  value: string,
  minimumLength: number,
  maximumLength: number,
): string => {
  const result = value.normalize("NFKC").trim();
  const length = [...result].length;
  if (
    length < minimumLength ||
    length > maximumLength ||
    CONTROL_CHARACTER.test(result)
  ) {
    throw new Error("INVALID_INPUT");
  }
  return result;
};

export const normalizeNickname = (value: string): string =>
  normalizedText(value, 1, 40);

export const normalizeLegalName = (value: string): string =>
  normalizedText(value, 1, 100);

export const normalizeResetReason = (value: string): string =>
  normalizedText(value, 1, 1_000);

export const normalizePhone = (value: string): string => {
  let result = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s()\-]/gu, "");
  if (result.startsWith("+86")) result = result.slice(3);
  else if (result.startsWith("0086")) result = result.slice(4);
  else if (result.length === 13 && result.startsWith("86")) result = result.slice(2);
  if (!MAINLAND_MOBILE.test(result)) throw new Error("INVALID_INPUT");
  return result;
};

export const phoneForLogin = (value: string): string | undefined => {
  try {
    return normalizePhone(value);
  } catch {
    return undefined;
  }
};

export const assertPasswordInput = (value: string): void => {
  if (value.length < 8 || value.length > 1_024) throw new Error("INVALID_INPUT");
};

export const assertIdempotencyKey = (value: string): string =>
  normalizedText(value, 1, 200);
