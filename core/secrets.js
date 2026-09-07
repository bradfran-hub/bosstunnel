"use strict";
const crypto = require("node:crypto");
class Secrets {
  constructor(secret) {
    if (typeof secret !== "string" || secret.length < 32) throw new Error("A persistent encryption secret of at least 32 characters is required");
    this.key = crypto.createHash("sha256").update(secret).digest();
  }
  seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(":");
  }
  open(value) {
    const [iv, tag, data] = String(value).split(":").map((part) => Buffer.from(part, "base64"));
    const cipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
  }
}
module.exports = { Secrets };
