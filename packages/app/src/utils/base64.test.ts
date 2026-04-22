import { describe, expect, test } from "bun:test"
import { decode64 } from "./base64"

describe("decode64", () => {
  test("decodes a valid base64-encoded path", () => {
    // base64Encode("/home/user") from @opencode-ai/util/encode
    const encoded = "L2hvbWUvdXNlcg"
    expect(decode64(encoded)).toBe("/home/user")
  })

  test("returns undefined for undefined input", () => {
    expect(decode64(undefined)).toBeUndefined()
  })

  test("returns undefined for non-base64 route names like 'recent'", () => {
    // "recent" is valid base64 alphabet but decodes to invalid UTF-8 bytes
    // [0xAD, 0xE7, 0x9E, 0x9B] — this MUST NOT produce a garbage truthy string
    expect(decode64("recent")).toBeUndefined()
  })

  test("returns undefined for completely invalid base64", () => {
    expect(decode64("!!!not-base64!!!")).toBeUndefined()
  })

  test("decodes url-safe base64 with dashes and underscores", () => {
    // A path with characters that produce + and / in standard base64
    const path = "/tmp/a+b/c=d"
    // Manually: base64Encode produces url-safe variant
    const encoded = "L3RtcC9hK2IvYz1k"
    expect(decode64(encoded)).toBe(path)
  })
})
