import { Module } from '@nestjs/common';
import { ThemeFrameworkCatalogueController } from './theme-framework-catalogue.controller';
import { ThemeFrameworkCatalogueService } from './theme-framework-catalogue.service';

@Module({ controllers: [ThemeFrameworkCatalogueController], providers: [ThemeFrameworkCatalogueService] })
export class ThemeFrameworkCatalogueModule {}
