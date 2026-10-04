/** Query parameter names that carry secrets and must never appear in a stored or shared address. */
const secretQueryParameterPattern = /^(?:access_?token|api_?key|auth|key|signature|token)$/i

/** The first query parameter of the URL whose name marks it as a secret, if any. */
export const secretQueryParameter = (url: URL): string | undefined =>
  [...url.searchParams.keys()].find((key) => secretQueryParameterPattern.test(key))
