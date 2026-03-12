# Clerk Organizations Setup Guide

This guide outlines the steps to configure **Clerk Organizations** for Project Synapse multi-tenancy.

## Official Documentation
- [Clerk Organizations Overview](https://clerk.com/docs/organizations/overview)
- [Managing Organizations via Dashboard](https://clerk.com/docs/organizations/manage-organizations)
- [Organization Settings Guide](https://clerk.com/docs/organizations/settings)

---

## Setup Steps (Dashboard)

### 1. Enable Organizations
1. Log in to your [Clerk Dashboard](https://dashboard.clerk.com).
2. Go to **Configure > Organization Settings**.
3. Toggle the **Enable Organizations** switch.

### 2. Configure Membership Requirements
Depending on your project goals, choose one:
- **Membership Required**: (Recommended for B2B) Every user must belong to an organization to use the app.
- **Membership Optional**: Users can have personal accounts or switch to organizations.

### 3. Create Your First Organization
1. Go to **Users & Organizations > Organizations**.
2. Click **Create Organization**.
3. Name it (e.g., "Seed Org").
4. **Important**: Copy the **Organization ID** (starts with `org_...`). You will need this for the Neo4j migration script.

### 4. Invite Users
1. Inside the organization you just created, go to the **Members** tab.
2. Click **Invite Members**.
3. Enter your Gmail address and assign a role (e.g., "Admin").

---

## Why this works for Project Synapse
By using Clerk's `org_id` as our `tenant_id` discriminator in Neo4j:
- **Opaque Security**: The ID is a random string (`org_2nb8...`), not a sensitive email or username.
- **Team Collaboration**: You can add more people to the same `org_id` later, and they will automatically see the same graph data.
- **Zero Management**: Clerk handles the "Invite/Accept" flow and the "Forget Password" flow for you.
