// /api/_middleware.js
export function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  
  // Enforce HTTPS
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  
  // Continue to the next handler
  return context.next();
}
