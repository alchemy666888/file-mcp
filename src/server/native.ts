import "server-only";
import { AppError } from "./errors";
import type { GoogleDrive } from "./google";
export const nativeKinds = {
  docs: "application/vnd.google-apps.document",
  sheets: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
} as const;
export type NativeKind = keyof typeof nativeKinds;
export async function readNative(
  drive: GoogleDrive,
  id: string,
  kind: NativeKind,
  range?: string,
) {
  const encoded = encodeURIComponent(id);
  if (kind === "docs")
    return drive.json<Record<string, unknown>>(
      `https://docs.googleapis.com/v1/documents/${encoded}`,
    );
  if (kind === "slides")
    return drive.json<Record<string, unknown>>(
      `https://slides.googleapis.com/v1/presentations/${encoded}`,
    );
  return drive.json<Record<string, unknown>>(
    range
      ? `https://sheets.googleapis.com/v4/spreadsheets/${encoded}/values/${encodeURIComponent(range)}`
      : `https://sheets.googleapis.com/v4/spreadsheets/${encoded}?fields=spreadsheetId,spreadsheetUrl,properties,sheets.properties`,
  );
}
export async function writeNative(
  drive: GoogleDrive,
  id: string,
  kind: NativeKind,
  input: {
    requests?: Record<string, unknown>[];
    revisionId?: string;
    range?: string;
    values?: (string | number | boolean | null)[][];
  },
) {
  const encoded = encodeURIComponent(id);
  if (kind === "sheets") {
    if (!input.range || !input.values)
      throw new AppError("RANGE_AND_VALUES_REQUIRED");
    return drive.json(
      `https://sheets.googleapis.com/v4/spreadsheets/${encoded}/values/${encodeURIComponent(input.range)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ range: input.range, values: input.values }),
      },
    );
  }
  if (!input.revisionId || !input.requests?.length)
    throw new AppError("REVISION_AND_REQUESTS_REQUIRED");
  const allowed =
    kind === "docs"
      ? [
          "insertText",
          "deleteContentRange",
          "replaceAllText",
          "updateTextStyle",
          "updateParagraphStyle",
          "insertTable",
        ]
      : [
          "createSlide",
          "insertText",
          "deleteText",
          "replaceAllText",
          "createShape",
          "updateTextStyle",
          "updateParagraphStyle",
          "updateShapeProperties",
        ];
  for (const request of input.requests) {
    const keys = Object.keys(request);
    if (keys.length !== 1 || !allowed.includes(keys[0]))
      throw new AppError("NATIVE_REQUEST_UNSUPPORTED");
  }
  const base =
    kind === "docs"
      ? "https://docs.googleapis.com/v1/documents"
      : "https://slides.googleapis.com/v1/presentations";
  return drive.json(`${base}/${encoded}:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: input.requests,
      writeControl: { requiredRevisionId: input.revisionId },
    }),
  });
}
