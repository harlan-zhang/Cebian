self.onmessage = (event) => {
  try {
    const { buffer, byteOffset, byteLength, mimeType } = event.data;
    const bytes = new Uint8Array(buffer, byteOffset, byteLength);
    const blob = new Blob([bytes], { type: mimeType });
    self.postMessage({ blob });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
