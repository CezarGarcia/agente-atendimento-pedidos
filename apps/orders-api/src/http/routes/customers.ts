import { Router } from 'express';

import type { OrdersService } from '../../application/orders-service.js';
import { presentCustomer } from '../presenters.js';
import { HttpProblem } from '../problem.js';
import { CustomerLookupRequestSchema } from '../schemas.js';

export function customersRouter(service: OrdersService): Router {
  const router = Router();

  /**
   * Identifica o cliente pelo telefone verificado pelo canal de mensagens. O telefone vai no corpo
   * (e não na URL) para não aparecer em logs de acesso. Devolve só o necessário: id e primeiro nome.
   */
  router.post('/customers/lookup', async (req, res) => {
    const { phone } = CustomerLookupRequestSchema.parse(req.body ?? {});
    const customer = await service.findCustomerByPhone(phone);
    if (!customer) {
      throw new HttpProblem('CUSTOMER_NOT_FOUND', 'Nenhum cliente cadastrado com este telefone.');
    }
    res.json(presentCustomer(customer));
  });

  return router;
}
