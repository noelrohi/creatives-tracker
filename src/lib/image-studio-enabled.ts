export function isImageStudioEnabled() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.NEXT_PUBLIC_IMAGE_STUDIO_ENABLED === "true"
  );
}
