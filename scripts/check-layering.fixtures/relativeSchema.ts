// Fixture: a relative path that resolves to shared/schemas. Earlier
// versions of the rule matched the raw specifier ("@shared/schemas") and
// silently allowed this form; the rule now operates on the resolved path.
import { foo } from "../../shared/schemas";

export const x = foo;
