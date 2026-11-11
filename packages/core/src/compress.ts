async function through(
	bytes: Uint8Array<ArrayBuffer>,
	stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
	const result = new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
	return new Uint8Array(await result);
}

export function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return through(bytes, new CompressionStream("deflate-raw"));
}

export function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return through(bytes, new DecompressionStream("deflate-raw"));
}
