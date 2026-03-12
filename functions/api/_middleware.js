import { applyCors, buildOptionsResponse } from "./_lib/cors.js";

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method === "OPTIONS") {
    return buildOptionsResponse(request);
  }

  const response = await next();
  return applyCors(request, response);
}
