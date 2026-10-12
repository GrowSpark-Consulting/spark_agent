-- Services, resources and working hours for the seeded businesses, so the services and
-- resources screens and the slot engine have data from Day 1. Safe to run more than once.
--
-- JSON shapes (contract for the slot engine and the settings screens):
--   working_hours / business_hours: { "mon": [{ "start": "10:00", "end": "19:00" }], ... }
--     keys mon..sun, local time in the tenant's timezone; several intervals allow split
--     shifts; a missing day or [] means closed.
--   service_area (field visits only): { "pincodes": ["600041", ...] }
--   A service is bookable on any active resource of the same tenant whose type equals
--   services.resource_type.

-- Business hours: set only while still empty, so edits made in the dashboard survive a re-run.
update public.tenants set business_hours = '{
  "mon": [{"start": "09:30", "end": "19:00"}], "tue": [{"start": "09:30", "end": "19:00"}],
  "wed": [{"start": "09:30", "end": "19:00"}], "thu": [{"start": "09:30", "end": "19:00"}],
  "fri": [{"start": "09:30", "end": "19:00"}], "sat": [{"start": "09:30", "end": "19:00"}],
  "sun": [{"start": "10:00", "end": "14:00"}]
}'
where id in ('d0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
             'd0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-0000000000a1',
             'd0000000-0000-0000-0000-0000000000b1')
  and business_hours = '{}';

insert into public.resources (id, tenant_id, type, name, working_hours, service_area) values
  -- Real estate: sales staff run site visits, Monday to Saturday plus Sunday mornings
  ('d5000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001', 'staff', 'Site Executive 1',
   '{"mon":[{"start":"10:00","end":"18:00"}],"tue":[{"start":"10:00","end":"18:00"}],"wed":[{"start":"10:00","end":"18:00"}],
     "thu":[{"start":"10:00","end":"18:00"}],"fri":[{"start":"10:00","end":"18:00"}],"sat":[{"start":"10:00","end":"18:00"}],
     "sun":[{"start":"10:00","end":"13:00"}]}', null),
  ('d5000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001', 'staff', 'Site Executive 2',
   '{"tue":[{"start":"10:00","end":"18:00"}],"wed":[{"start":"10:00","end":"18:00"}],"thu":[{"start":"10:00","end":"18:00"}],
     "fri":[{"start":"10:00","end":"18:00"}],"sat":[{"start":"10:00","end":"18:00"}],"sun":[{"start":"10:00","end":"13:00"}]}', null),
  -- Interiors: designers visit homes inside their pincodes, with a lunch break
  ('d5000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000002', 'designer', 'Designer 1',
   '{"mon":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}],"tue":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}],
     "wed":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}],"thu":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}],
     "fri":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}],"sat":[{"start":"10:00","end":"13:00"},{"start":"14:00","end":"18:00"}]}',
   '{"pincodes":["600041","600096","600097","600119"]}'),
  ('d5000000-0000-0000-0000-000000000022', 'd0000000-0000-0000-0000-000000000002', 'designer', 'Designer 2',
   '{"mon":[{"start":"11:00","end":"19:00"}],"wed":[{"start":"11:00","end":"19:00"}],"fri":[{"start":"11:00","end":"19:00"}],
     "sat":[{"start":"11:00","end":"19:00"}]}',
   '{"pincodes":["600020","600028","600090"]}'),
  -- Salon: stylists, closed Mondays
  ('d5000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000003', 'stylist', 'Stylist 1',
   '{"tue":[{"start":"10:00","end":"20:00"}],"wed":[{"start":"10:00","end":"20:00"}],"thu":[{"start":"10:00","end":"20:00"}],
     "fri":[{"start":"10:00","end":"20:00"}],"sat":[{"start":"09:00","end":"21:00"}],"sun":[{"start":"09:00","end":"21:00"}]}', null),
  ('d5000000-0000-0000-0000-000000000032', 'd0000000-0000-0000-0000-000000000003', 'stylist', 'Stylist 2',
   '{"tue":[{"start":"12:00","end":"20:00"}],"thu":[{"start":"12:00","end":"20:00"}],"sat":[{"start":"09:00","end":"21:00"}],
     "sun":[{"start":"09:00","end":"21:00"}]}', null),
  -- Isolation tests: one resource each
  ('d5000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'staff', 'Isolation A Staff',
   '{"mon":[{"start":"10:00","end":"18:00"}]}', null),
  ('d5000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', 'staff', 'Isolation B Staff',
   '{"mon":[{"start":"10:00","end":"18:00"}]}', null)
on conflict (id) do nothing;

insert into public.services (id, tenant_id, name, duration_min, price_min, price_max, resource_type) values
  ('d6000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001', 'Site visit',            60, null, null, 'staff'),
  ('d6000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001', 'Video walkthrough',     30, null, null, 'staff'),
  ('d6000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000002', 'Home measurement visit', 60, 0,    0,    'designer'),
  ('d6000000-0000-0000-0000-000000000022', 'd0000000-0000-0000-0000-000000000002', 'Design consultation',    45, 0,    0,    'designer'),
  ('d6000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000003', 'Haircut',               30, 300,  600,  'stylist'),
  ('d6000000-0000-0000-0000-000000000032', 'd0000000-0000-0000-0000-000000000003', 'Hair colour',           90, 1500, 3500, 'stylist'),
  ('d6000000-0000-0000-0000-000000000033', 'd0000000-0000-0000-0000-000000000003', 'Bridal trial',          90, 2500, 5000, 'stylist'),
  ('d6000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'Isolation A service',   30, null, null, 'staff'),
  ('d6000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', 'Isolation B service',   30, null, null, 'staff')
on conflict (id) do nothing;

-- The real-estate demo, ready for the Day 3 test (Dev 1's Day 3 note, section 7): projects the assistant scores against,
-- and the one service it books. Scoring reads each active catalog row's price_from (the lowest price, rupees) and, in
-- attributes, price_to and area (backend/src/agent/scoring/references.ts, CATALOG_ATTRIBUTES): with none, the budget and
-- area rules earn nothing and no lead can be hot. With two services and none named, every booking would go to a person.
insert into public.catalog_items (id, tenant_id, type, title, summary, price_from, price_unit, attributes) values
  ('d8000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001', 'property', 'Skyline Towers',
   '2 and 3 BHK apartments near Velachery station, ready to move in.', 6500000, 'total',
   '{"price_to": 9000000, "area": "Velachery", "configs": ["2BHK", "3BHK"]}'),
  ('d8000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001', 'property', 'Green Meadows',
   '1, 2 and 3 BHK homes on OMR, handover in 2027.', 4500000, 'total',
   '{"price_to": 7000000, "area": "OMR", "configs": ["1BHK", "2BHK", "3BHK"]}'),
  ('d8000000-0000-0000-0000-000000000013', 'd0000000-0000-0000-0000-000000000001', 'property', 'Lake View Residency',
   '2 BHK apartments by the lake in Tambaram, ready to move in.', 3500000, 'total',
   '{"price_to": 5500000, "area": "Tambaram", "configs": ["2BHK"]}')
on conflict (id) do nothing;

-- The service the assistant books (tenants.agent_settings.bookingServiceId): Site visit. Set only while unset, so a
-- choice made in the dashboard survives a re-run.
update public.tenants
   set agent_settings = agent_settings || '{"bookingServiceId": "d6000000-0000-0000-0000-000000000011"}'
 where id = 'd0000000-0000-0000-0000-000000000001'
   and not (agent_settings ? 'bookingServiceId');
