import * as z from 'zod';
const User = z.object({ id: z.number().int().positive(), name: z.string().min(1).max(40), email: z.email(), role: z.enum(['admin', 'member', 'guest']), tags: z.array(z.string()).max(5).default([]), address: z.object({ city: z.string(), zip: z.string().regex(/^\d{5}$/) }).optional(), born: z.coerce.date().optional() });
const Event = z.discriminatedUnion('type', [z.object({ type: z.literal('login'), user: User }), z.object({ type: z.literal('logout'), id: z.number() })]);
const good = User.safeParse({ id: 1, name: 'Ada', email: 'ada@example.com', role: 'admin', address: { city: 'London', zip: '12345' }, born: '1815-12-10' });
const bad = User.safeParse({ id: -1, name: '', email: 'nope', role: 'x' });
console.log(good.success, bad.success, bad.success ? 0 : bad.error.issues.map((i) => i.path.join('.') + ':' + i.code).join(','));
console.log(Event.safeParse({ type: 'logout', id: 3 }).success, Event.safeParse({ type: 'other' }).success, z.toJSONSchema(User.omit({ born: true })).required);
