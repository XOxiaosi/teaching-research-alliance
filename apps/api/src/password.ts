import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const FORMAT = "scrypt-v1";
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 3;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1_024;

const validPasswordLength = (password: string): boolean =>
  password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;

const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY
  }, (error, key) => {
    if (error !== null) reject(error);
    else resolve(key);
  });
});

export const hashPassword = async (password: string): Promise<string> => {
  if (!validPasswordLength(password)) throw new Error("PASSWORD_LENGTH_INVALID");
  const salt = randomBytes(SALT_LENGTH);
  const digest = await derive(password, salt);
  return [
    FORMAT,
    COST.toString(),
    BLOCK_SIZE.toString(),
    PARALLELIZATION.toString(),
    salt.toString("base64url"),
    digest.toString("base64url")
  ].join("$");
};

export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  if (!validPasswordLength(password)) return false;
  try {
    const parts = encoded.split("$");
    if (parts.length !== 6) return false;
    const [format, costText, blockSizeText, parallelizationText, saltText, digestText] = parts;
    if (
      format !== FORMAT
      || costText !== COST.toString()
      || blockSizeText !== BLOCK_SIZE.toString()
      || parallelizationText !== PARALLELIZATION.toString()
      || saltText === undefined
      || digestText === undefined
      || !/^[A-Za-z0-9_-]+$/.test(saltText)
      || !/^[A-Za-z0-9_-]+$/.test(digestText)
    ) return false;
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
    const actual = await derive(password, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};
