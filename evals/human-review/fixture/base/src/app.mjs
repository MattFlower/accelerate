import { OrderStore } from './storage/orders.mjs';
import { OrderService } from './orders/service.mjs';
import { orderHandlers } from './http/orders.mjs';
import { Scheduler } from './retry/scheduler.mjs';
import { loadSettings } from './config/settings.mjs';

/** Composition root; transports can wrap these request-shaped handlers. */
export function createApp({ env = {}, clock = Date.now, nextId } = {}) {
  const settings = loadSettings(env);
  const store = new OrderStore({ capacity: settings.cacheCapacity });
  const service = new OrderService(store, { clock, nextId });
  const handlers = orderHandlers(service);
  const scheduler = new Scheduler(settings.retry, clock);
  return { settings, store, service, handlers, scheduler };
}
