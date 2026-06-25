-- Seed the e2e test account for the mock-store Maestro flows.
-- Run in the Supabase SQL editor (service role). The account test@mealio.co must
-- already exist (sign it up in the app first, which also creates its
-- user_profiles row). Re-runnable: it clears prior mockstore meals first.
--
-- Scenario rides in each ingredient's search term (see tests/mock-store/README.md):
--   default → auto-add · multi → choose · oos → out-of-stock · noresults → skip
--   failadd → reconcile

-- 1) Make the account paid so the 6-meal seed isn't blocked by the free 3-meal limit.
update user_profiles
set subscription_tier = 'paid'
where id = (select id from auth.users where email = 'test@mealio.co');

-- 2) Clear any prior mockstore meals for a clean, idempotent seed.
delete from meals
where store_id = 'mockstore'
  and user_id = (select id from auth.users where email = 'test@mealio.co');

-- 3) Insert the six scenario meals.
insert into meals (user_id, name, store_id, ingredients, is_active, created_at)
select u.id, m.name, 'mockstore', m.ingredients::jsonb, true, now()
from auth.users u
cross join (values
  ('E2E Happy', '[
     {"ingredientName":"milk","searchTerm":"milk","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null},
     {"ingredientName":"eggs","searchTerm":"eggs","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null},
     {"ingredientName":"bread","searchTerm":"bread","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]'),
  ('E2E Choose', '[
     {"ingredientName":"cheese multi","searchTerm":"cheese multi","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]'),
  ('E2E Skip', '[
     {"ingredientName":"rice noresults","searchTerm":"rice noresults","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]'),
  ('E2E OOS', '[
     {"ingredientName":"soda oos","searchTerm":"soda oos","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]'),
  ('E2E Reconcile', '[
     {"ingredientName":"ham failadd","searchTerm":"ham failadd","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]'),
  ('E2E Parallel', '[
     {"ingredientName":"milk","searchTerm":"milk","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null},
     {"ingredientName":"eggs","searchTerm":"eggs","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null},
     {"ingredientName":"bread","searchTerm":"bread","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null},
     {"ingredientName":"butter","searchTerm":"butter","qty":1,"productQty":1,"unit":"qty","measure":null,"dropdown":null}]')
) as m(name, ingredients)
where u.email = 'test@mealio.co';
