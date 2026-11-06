import { z } from "@hono/zod-openapi";

export const meSchema = z
  .object({
    sub: z.string().min(1).openapi({ example: "0c7d0b0e-4cdd-44ac-a0e1-10c81a487ae1" }),
    name: z.string().optional().openapi({ example: "beluga-admin" }),
    groups: z.array(z.string()).openapi({ example: ["admins"] }),
  })
  .openapi("CurrentUser");

export type Me = z.infer<typeof meSchema>;
