package com.fason.app.features.gps.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [LocationEntity::class], version = 3, exportSchema = false)
abstract class LocationDatabase : RoomDatabase() {

    abstract fun locationDao(): LocationDao

    companion object {
        @Volatile
        private var INSTANCE: LocationDatabase? = null

        fun getInstance(context: Context): LocationDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    LocationDatabase::class.java,
                    "location_cache.db"
                )
                    // Nếu app đang ở bản Production (có người dùng), hãy thay thế dòng dưới bằng 
                    // .addMigrations(MIGRATION_1_2) để không mất dữ liệu offline cũ.
                    .fallbackToDestructiveMigration() 
                    .build()
                    .also { INSTANCE = it }
            }
        }

        fun destroyInstance() {
            try {
                INSTANCE?.close()
            } catch (_: Exception) { }
            INSTANCE = null
        }
    }
}