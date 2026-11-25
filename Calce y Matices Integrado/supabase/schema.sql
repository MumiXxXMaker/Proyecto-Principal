create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  phone text check (phone is null or phone ~ '^\+56 9 [0-9]{4} [0-9]{4}$'),
  bust numeric,
  waist numeric,
  hip numeric,
  remember_measurements boolean not null default false,
  remember_photo boolean not null default false,
  photo_path text,
  avatar_path text,
  color_palette jsonb not null default '[]'::jsonb
    check (jsonb_typeof(color_palette) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles
  add column if not exists email text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists phone text
    check (phone is null or phone ~ '^\+56 9 [0-9]{4} [0-9]{4}$'),
  add column if not exists remember_measurements boolean not null default false,
  add column if not exists remember_photo boolean not null default false,
  add column if not exists photo_path text,
  add column if not exists avatar_path text;

create or replace function public.set_user_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select users.email
    into new.email
  from auth.users as users
  where users.id = new.user_id;

  if not found then
    raise exception 'Profile must reference an authenticated user.';
  end if;

  return new;
end;
$$;

revoke all on function public.set_user_profile_email()
  from public, anon, authenticated;

drop trigger if exists set_user_profile_email
  on public.user_profiles;
create trigger set_user_profile_email
  before insert or update of user_id, email
  on public.user_profiles
  for each row
  execute function public.set_user_profile_email();

create or replace function public.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (user_id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'first_name', ''),
    nullif(new.raw_user_meta_data ->> 'last_name', '')
  )
  on conflict (user_id) do update
  set email = excluded.email,
      first_name = coalesce(
        public.user_profiles.first_name,
        excluded.first_name
      ),
      last_name = coalesce(
        public.user_profiles.last_name,
        excluded.last_name
      );
  return new;
end;
$$;

revoke all on function public.sync_auth_user_profile()
  from public, anon, authenticated;

drop trigger if exists sync_auth_user_profile
  on auth.users;
create trigger sync_auth_user_profile
  after insert or update of email, raw_user_meta_data
  on auth.users
  for each row
  execute function public.sync_auth_user_profile();

insert into public.user_profiles (user_id, email, first_name, last_name)
select
  users.id,
  users.email,
  nullif(users.raw_user_meta_data ->> 'first_name', ''),
  nullif(users.raw_user_meta_data ->> 'last_name', '')
from auth.users as users
on conflict (user_id) do update
set email = excluded.email,
    first_name = coalesce(public.user_profiles.first_name, excluded.first_name),
    last_name = coalesce(public.user_profiles.last_name, excluded.last_name);

update public.user_profiles
set remember_measurements = true
where bust is not null
   or waist is not null
   or hip is not null
   or color_palette <> '[]'::jsonb;

alter table public.user_profiles enable row level security;

revoke all on public.user_profiles from anon;
grant select, insert, update, delete on public.user_profiles to authenticated;

drop policy if exists "Users can read their own profile"
  on public.user_profiles;
create policy "Users can read their own profile"
  on public.user_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own profile"
  on public.user_profiles;
create policy "Users can insert their own profile"
  on public.user_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile"
  on public.user_profiles;
create policy "Users can update their own profile"
  on public.user_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own profile"
  on public.user_profiles;
create policy "Users can delete their own profile"
  on public.user_profiles for delete to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.user_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  address_name text not null
    check (char_length(btrim(address_name)) between 1 and 80),
  street text not null check (char_length(btrim(street)) between 1 and 120),
  street_number text not null
    check (char_length(btrim(street_number)) between 1 and 20),
  dwelling_type text not null
    check (dwelling_type in ('casa', 'departamento', 'condominio', 'oficina', 'otro')),
  dwelling_number text not null
    check (char_length(btrim(dwelling_number)) between 1 and 30),
  commune text not null check (char_length(btrim(commune)) between 1 and 80),
  region text not null check (char_length(btrim(region)) between 1 and 80),
  postal_code text not null
    check (char_length(btrim(postal_code)) between 1 and 12),
  created_at timestamptz not null default now()
);

create index if not exists user_addresses_user_id_created_at_idx
  on public.user_addresses (user_id, created_at desc);

alter table public.user_addresses enable row level security;

revoke all on public.user_addresses from anon;
grant select, insert, update, delete on public.user_addresses to authenticated;

drop policy if exists "Users can read their own shipping addresses"
  on public.user_addresses;
create policy "Users can read their own shipping addresses"
  on public.user_addresses for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own shipping addresses"
  on public.user_addresses;
create policy "Users can insert their own shipping addresses"
  on public.user_addresses for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own shipping addresses"
  on public.user_addresses;
create policy "Users can update their own shipping addresses"
  on public.user_addresses for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own shipping addresses"
  on public.user_addresses;
create policy "Users can delete their own shipping addresses"
  on public.user_addresses for delete to authenticated
  using ((select auth.uid()) = user_id);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'user-profile-photos',
  'user-profile-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their own profile photos"
  on storage.objects;
create policy "Users can read their own profile photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'user-profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their own profile photos"
  on storage.objects;
create policy "Users can upload their own profile photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own profile photos"
  on storage.objects;
create policy "Users can update their own profile photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'user-profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'user-profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own profile photos"
  on storage.objects;
create policy "Users can delete their own profile photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'user-profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

notify pgrst, 'reload schema';
