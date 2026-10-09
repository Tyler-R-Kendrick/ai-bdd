/** Lazy stdio transport binding, so importing the module never opens stdin. */
export async function stdioTransport(): Promise<unknown> {
  const module = (await import('@modelcontextprotocol/server/stdio')) as { StdioServerTransport: new () => unknown };
  return new module.StdioServerTransport();
}
