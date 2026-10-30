import {
  bindingConfigFromEnv,
  bindingJobExecutor,
} from '../server/hosting/binding.ts';
import { createVercelJobCallback } from '../server/hosting/vercel-queue.ts';
export default {
  fetch(request: Request) {
    const binding = bindingConfigFromEnv(process.env);
    return createVercelJobCallback({
      region: process.env.STUDIO_QUEUE_REGION ?? 'iad1',
      maxRequestSeconds: binding.maxRequestSeconds,
      executor: bindingJobExecutor(binding),
    })(request);
  },
};
