import assert from "node:assert/strict";
import test from "node:test";
import { createPickedFinanceAttachment, detectFinanceAttachmentMediaType, MAX_FINANCE_ATTACHMENT_BYTES } from "../dist/finance-attachment-helpers.js";

const bytes = (...values) => Uint8Array.from(values).buffer;

test("finance attachment helper validates real magic bytes and never treats a path or base64 string as an original", () => {
  assert.equal(detectFinanceAttachmentMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(detectFinanceAttachmentMediaType(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(detectFinanceAttachmentMediaType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d)), "application/pdf");
  assert.equal(detectFinanceAttachmentMediaType(bytes(0x69, 0x56, 0x42, 0x4f, 0x52)), null);
  assert.deepEqual(createPickedFinanceAttachment("单据.png", "wxfile://temporary.png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), {
    name: "单据.png", temporaryPath: "wxfile://temporary.png", bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), mediaType: "image/png"
  });
  assert.throws(() => createPickedFinanceAttachment("fake.pdf", "wxfile://path", new TextEncoder().encode("data:application/pdf;base64,JVBER").buffer));
  assert.throws(() => createPickedFinanceAttachment("large.pdf", "wxfile://path", new ArrayBuffer(MAX_FINANCE_ATTACHMENT_BYTES + 1)));
});
