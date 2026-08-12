import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const privilegeSchema = z.enum(["select", "insert", "update", "delete"]);
export const maskKindSchema = z.enum(["hash", "partial", "null"]);

export const grantSchema = z.object({
  roles: z.array(z.string()).min(1),
  privileges: z.array(privilegeSchema).min(1),
  columnMask: z.record(z.string(), maskKindSchema).optional(),
  rowFilter: z.string().optional(),
});

export const resourceSchema = z.object({
  resource: z.string().min(1),
  classification: z.enum(["public", "internal", "pii"]),
  grants: z.array(grantSchema),
});

export const roleSchema = z.object({
  name: z.string().min(1),
  includes: z.array(z.string()).optional(),
});

export const groupSchema = z.object({
  name: z.string().min(1),
  roles: z.array(z.string()).min(1),
});

export const declarationSchema = z.object({
  roles: z.array(roleSchema),
  groups: z.array(groupSchema),
  resources: z.array(resourceSchema),
});

export type Privilege = z.infer<typeof privilegeSchema>;
export type MaskKind = z.infer<typeof maskKindSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Group = z.infer<typeof groupSchema>;
export type Declaration = z.infer<typeof declarationSchema>;

export function parseDeclaration(yamlText: string): Declaration {
  return declarationSchema.parse(parseYaml(yamlText));
}
