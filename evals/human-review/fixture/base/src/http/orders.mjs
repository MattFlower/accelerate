import { json, errorResponse, pagination } from './response.mjs';
import { publicOrder } from '../orders/model.mjs';

export function orderHandlers(service) {
  return {
    create(request) {
      try {
        const token = request.headers?.['idempotency-token'];
        const result = service.submit(request.body, token);
        return json(result.created ? 201 : 200, publicOrder(result.order));
      } catch (error) {
        return errorResponse(error);
      }
    },

    get(request) {
      const order = service.get(request.params.id);
      return order ? json(200, publicOrder(order)) : json(404, { error: 'order not found' });
    },

    update(request) {
      try {
        return json(200, publicOrder(service.changeStatus(request.params.id, request.body.status)));
      } catch (error) {
        return errorResponse(error);
      }
    },

    list(request) {
      try {
        return json(200, { orders: service.list(pagination(request.query)).map(publicOrder) });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
