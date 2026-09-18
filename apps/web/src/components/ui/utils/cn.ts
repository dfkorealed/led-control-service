import { extendTailwindMerge } from "tailwind-merge";

// The product resets Tailwind's font-size namespace; these names are sizes,
// not colors, even though both utilities start with `text-`.
const merge = extendTailwindMerge({
  extend: {
    theme: { text: ["display", "page-title", "section-title", "card-title", "body-lg", "body", "body-sm", "label", "caption", "overline", "metric"] }
  }
});

export function cn(...classes: Array<string | false | null | undefined>) {
  return merge(classes.filter(Boolean).join(" "));
}
