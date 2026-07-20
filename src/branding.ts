export const brandPrefix = "GA - ";
export const brandAttribution = "Made by Georgiana Alba (GA).";

export const brand = (message: string): string =>
  message.startsWith(brandPrefix) ? message : `${brandPrefix}${message}`;
