// Whether a walk of this file failed, which setup.mts hears, for its
// lab's close to keep what it left (labApp.mts).
let failed = false;

export const noteWalkFailed = (): void => {
  failed = true;
};
export const walkFailed = (): boolean => failed;
