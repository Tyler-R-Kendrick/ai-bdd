import {
  bindingConfigFromEnv,
  bindingMaintenanceExecutor,
} from '../server/hosting/binding.ts';
import { createMaintenanceCallback } from '../server/hosting/vercel-scheduler.ts';
export default {
  fetch(request: Request) {
    return createMaintenanceCallback({
      region: process.env.STUDIO_QUEUE_REGION ?? 'iad1',
      execute: bindingMaintenanceExecutor(bindingConfigFromEnv(process.env)),
    })(request);
  },
};
