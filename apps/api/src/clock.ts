// AUTH.md section 8: one injectable clock. Production injects the system
// clock; tests inject a controlled one.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
