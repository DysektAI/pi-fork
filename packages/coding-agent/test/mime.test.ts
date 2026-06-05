import { describe, expect, it } from "vitest";
import { detectSupportedImageMimeType } from "../src/utils/mime.ts";

describe("detectSupportedImageMimeType", () => {
	it("detects JPEG from magic bytes", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		expect(detectSupportedImageMimeType(jpeg)).toBe("image/jpeg");
	});

	it("returns null for JPEG-LS (0xFFF7)", () => {
		const jpegLs = new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x10]);
		expect(detectSupportedImageMimeType(jpegLs)).toBeNull();
	});

	it("detects PNG from magic bytes", () => {
		// Valid PNG: signature + IHDR chunk (length=13, type=IHDR)
		const png = new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d, // IHDR chunk length = 13
			0x49,
			0x48,
			0x44,
			0x52, // "IHDR"
			// IHDR data (13 bytes)
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x01,
			0x08,
			0x02,
			0x00,
			0x00,
			0x00,
			// CRC (4 bytes)
			0x90,
			0x77,
			0x53,
			0xde,
			// IDAT chunk
			0x00,
			0x00,
			0x00,
			0x01, // length
			0x49,
			0x44,
			0x41,
			0x54, // "IDAT"
		]);
		expect(detectSupportedImageMimeType(png)).toBe("image/png");
	});

	it("returns null for animated PNG (acTL before IDAT)", () => {
		const apng = new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d, // IHDR chunk length = 13
			0x49,
			0x48,
			0x44,
			0x52, // "IHDR"
			// IHDR data (13 bytes)
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x01,
			0x08,
			0x02,
			0x00,
			0x00,
			0x00,
			// CRC (4 bytes)
			0x90,
			0x77,
			0x53,
			0xde,
			// acTL chunk (animation control)
			0x00,
			0x00,
			0x00,
			0x08, // length
			0x61,
			0x63,
			0x54,
			0x4c, // "acTL"
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x00, // data
			// CRC
			0x00,
			0x00,
			0x00,
			0x00,
		]);
		expect(detectSupportedImageMimeType(apng)).toBeNull();
	});

	it("detects GIF", () => {
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
		expect(detectSupportedImageMimeType(gif)).toBe("image/gif");
	});

	it("detects WebP", () => {
		// "RIFF" + 4 bytes size + "WEBP"
		const webp = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46, // "RIFF"
			0x00,
			0x00,
			0x00,
			0x00, // size (doesn't matter for detection)
			0x57,
			0x45,
			0x42,
			0x50, // "WEBP"
		]);
		expect(detectSupportedImageMimeType(webp)).toBe("image/webp");
	});

	it("returns null for unknown format", () => {
		const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		expect(detectSupportedImageMimeType(unknown)).toBeNull();
	});

	it("returns null for empty buffer", () => {
		const empty = new Uint8Array(0);
		expect(detectSupportedImageMimeType(empty)).toBeNull();
	});

	it("returns null for too-short buffer", () => {
		const short = new Uint8Array([0xff, 0xd8]);
		expect(detectSupportedImageMimeType(short)).toBeNull();
	});
});
