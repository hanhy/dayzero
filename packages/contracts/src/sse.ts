// Incremental SSE parsing shared by the provider stream and browser client.
// Handles UTF-8 characters, CRLF and events split across arbitrary chunks.
export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    event = 'message',
    data: string[] = [],
    eventSize = 0,
    ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 1_048_576) throw new Error('流式响应数据过大');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
          eventSize = 0;
        } else if (line.startsWith('event:'))
          event = line.slice(6).replace(/^ /, '');
        else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          eventSize += value.length;
          if (eventSize > 1_048_576) throw new Error('流式响应数据过大');
          data.push(value);
        }
      }
      if (chunk.done) {
        ended = true;
        break;
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
