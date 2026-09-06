/**
 * Upload an image from a URL to Tlon storage.
 */
import { fetchWithSsrFGuard } from "lcx-agent/plugin-sdk";
import { getDefaultSsrFPolicy } from "./context.js";

const TLON_API_PACKAGE = "@tloncorp/api";

type TlonApiModule = {
  configureClient?: (params: {
    shipUrl: string;
    shipName: string;
    verbose: boolean;
    getCode: () => Promise<string>;
  }) => Promise<unknown> | unknown;
  uploadFile?: (params: {
    blob: Blob;
    fileName?: string;
    contentType?: string;
  }) => Promise<{ url: string }>;
};

let injectedTlonApiModule: TlonApiModule | undefined;

export function setTlonApiModuleForTest(module: TlonApiModule | undefined): void {
  injectedTlonApiModule = module;
}

async function loadTlonApiModule(): Promise<TlonApiModule | undefined> {
  if (injectedTlonApiModule) {
    return injectedTlonApiModule;
  }
  try {
    const module = (await import(TLON_API_PACKAGE)) as unknown;
    return module && typeof module === "object" ? (module as TlonApiModule) : undefined;
  } catch (error) {
    console.warn(
      `[tlon] Optional @tloncorp/api unavailable, media upload will fall back: ${error}`,
    );
    return undefined;
  }
}

export async function configureTlonUploadClient(params: {
  shipUrl: string;
  shipName: string;
  verbose: boolean;
  getCode: () => Promise<string>;
}): Promise<boolean> {
  const api = await loadTlonApiModule();
  if (typeof api?.configureClient !== "function") {
    return false;
  }
  await api.configureClient(params);
  return true;
}

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Returns the uploaded URL, or falls back to the original URL on error.
 *
 * Note: configureTlonUploadClient should be called before using this function.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    // Validate URL is http/https before fetching
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
      return imageUrl;
    }

    // Fetch the image with SSRF protection
    // Use fetchWithSsrFGuard directly (not urbitFetch) to preserve the full URL path
    const { response, release } = await fetchWithSsrFGuard({
      url: imageUrl,
      init: { method: "GET" },
      policy: getDefaultSsrFPolicy(),
      auditContext: "tlon-upload-image",
    });

    try {
      if (!response.ok) {
        console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
        return imageUrl;
      }

      const contentType = response.headers.get("content-type") || "image/png";
      const blob = await response.blob();

      // Extract filename from URL or use a default
      const urlPath = new URL(imageUrl).pathname;
      const fileName = urlPath.split("/").pop() || `upload-${Date.now()}.png`;

      const api = await loadTlonApiModule();
      if (typeof api?.uploadFile !== "function") {
        console.warn("[tlon] Optional @tloncorp/api uploadFile unavailable; using original URL");
        return imageUrl;
      }

      // Upload to Tlon storage
      const result = await api.uploadFile({
        blob,
        fileName,
        contentType,
      });

      return result.url;
    } finally {
      await release();
    }
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${err}`);
    return imageUrl;
  }
}
