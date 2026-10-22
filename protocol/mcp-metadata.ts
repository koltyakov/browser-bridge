/** Editable MCP metadata consumed by the native catalog generator. */
export interface McpSchema {
  $schema?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, McpSchema>;
  required?: string[];
  additionalProperties?: boolean | McpSchema;
  propertyNames?: McpSchema;
  items?: McpSchema;
  anyOf?: McpSchema[];
  oneOf?: McpSchema[];
  allOf?: McpSchema[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface McpToolMetadata {
  name: string;
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  inputSchema: McpSchema;
}

export interface McpMetadata {
  $comment: string;
  allTools: McpToolMetadata[];
  modernTools: string[];
  legacyTools: string[];
  loadableTools: string[];
  toolBindings: Record<string, string>;
  instructions: string;
  legacyInstructions: string;
}
