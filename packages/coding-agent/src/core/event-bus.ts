import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export type EventBusErrorHandler = (channel: string, error: unknown) => void;

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(onError?: EventBusErrorHandler): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					if (onError) {
						onError(channel, err);
					} else {
						process.stderr.write(
							`Event handler error (${channel}): ${err instanceof Error ? err.message : String(err)}\n`,
						);
					}
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
