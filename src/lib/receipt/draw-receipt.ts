// Draws a receipt to a PNG on a canvas.
//
// Hand-drawn rather than rasterising the DOM: html2canvas would be a sizeable
// dependency for one fixed layout, and the layout here is a stack of rows.

import type { Receipt } from "./receipt-data";

const WIDTH = 860;
const PADDING = 56;
const ROW_HEIGHT = 64;
// Drawn at 2x so the image stays sharp when shared and viewed full-screen.
const SCALE = 2;

const INK = "#f5f3f0";
const MUTED = "#a19d9d";
const ACCENT = "#c9a962";
const SURFACE = "#1a1918";
const LINE = "rgba(255,255,255,0.10)";

const STATUS_INK: Record<string, string> = {
  Completed: "#59c27a",
  "In progress": ACCENT,
  Failed: "#e07a7e",
};

// From the asset's own viewBox (523 x 133), so the mark is never stretched.
const LOGO_SRC = "/brand/settu-logo.svg";
const LOGO_RATIO = 523 / 133;
const LOGO_HEIGHT = 30;

function font(size: number, weight = 400): string {
  return `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
}

/** Resolves null rather than rejecting, so a missing logo can't lose a receipt. */
function loadLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // Same-origin, so the canvas stays untainted and toBlob still works.
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = LOGO_SRC;
  });
}

/** Returns a PNG blob, or null where canvas isn't available. */
export async function drawReceipt(receipt: Receipt): Promise<Blob | null> {
  if (typeof document === "undefined") return null;

  const height = PADDING * 2 + 190 + receipt.fields.length * ROW_HEIGHT + 90;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, WIDTH, height);

  // Gold rule along the top, the one brand mark on an otherwise plain card.
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, WIDTH, 6);

  let y = PADDING + 30;

  const logo = await loadLogo();
  if (logo) {
    // Baseline-aligned with the title on the right, not top-aligned.
    ctx.drawImage(
      logo,
      PADDING,
      y - LOGO_HEIGHT + 6,
      LOGO_HEIGHT * LOGO_RATIO,
      LOGO_HEIGHT,
    );
  } else {
    ctx.fillStyle = ACCENT;
    ctx.font = font(26, 700);
    ctx.fillText("SETTU", PADDING, y);
  }

  ctx.fillStyle = MUTED;
  ctx.font = font(20);
  ctx.textAlign = "right";
  ctx.fillText(receipt.title, WIDTH - PADDING, y);
  ctx.textAlign = "left";

  y += 70;
  ctx.fillStyle = INK;
  ctx.font = font(52, 700);
  ctx.fillText(receipt.headline, PADDING, y);

  y += 44;
  ctx.fillStyle = STATUS_INK[receipt.status] ?? MUTED;
  ctx.font = font(22, 600);
  ctx.fillText(receipt.status, PADDING, y);

  y += 40;
  for (const field of receipt.fields) {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING, y);
    ctx.lineTo(WIDTH - PADDING, y);
    ctx.stroke();

    y += ROW_HEIGHT * 0.62;
    ctx.fillStyle = MUTED;
    ctx.font = font(21);
    ctx.fillText(field.label, PADDING, y);

    ctx.fillStyle = INK;
    ctx.font = font(21, 600);
    ctx.textAlign = "right";
    ctx.fillText(field.value, WIDTH - PADDING, y);
    ctx.textAlign = "left";
    y += ROW_HEIGHT * 0.38;
  }

  y += 26;
  ctx.fillStyle = MUTED;
  ctx.font = font(18);
  ctx.fillText(`Reference  ${receipt.reference}`, PADDING, y);

  y += 30;
  ctx.fillText("settu.xyz", PADDING, y);

  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/png"),
  );
}
